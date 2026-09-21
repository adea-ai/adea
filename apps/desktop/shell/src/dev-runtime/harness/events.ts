// Canonical runtime-session event log (#400): the durable, append-only,
// sequence-ordered store behind `dev.session.events` and the
// `runtime-events-v1` stream.
//
// Spec contract (dev-runtime.md "Event model"), enforced here:
// - one monotonic `seq` per (runtime session, generation), canonical uint64;
// - dedupe on `(runtimeSessionId, generation, source, sourceEventId)`: the
//   identical event is an ignored duplicate; a different event under the same
//   key is `idempotency_conflict` and is never appended;
// - bounded retention: oldest events drop first per session, so storage and
//   replay windows stay bounded (terminal bodies are references, never
//   duplicated into this log);
// - `host`-source lifecycle events (session/run created, starting, resumed,
//   cancelled, observed status) are `authoritative` host facts with
//   `workspace_metadata` classification; harness-owned turn/tool/approval
//   events arrive through their own tiers and are never fabricated here.
//
// Stored records carry the scope envelope internally (the wire `RuntimeEvent`
// DTO allows no extra keys); every read projects the strict DTO only.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type {
  RuntimeEvent,
  RuntimeEventKind,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { createDurableJsonStore } from '../host-store'

const EVENTS_STORE_FILE = join('dev-runtime', 'harness', 'session-events.json')

/** Maximum retained events per (scope, runtime session). */
export const MAX_EVENTS_PER_SESSION = 1000
/** Maximum retained events across the scope (bounds the durable file). */
export const MAX_TOTAL_EVENTS = 5000
/** Read page bounds (spec: page maximum 500, default 100). */
export const EVENT_PAGE_DEFAULT = 100
export const EVENT_PAGE_MAX = 500

type StoredEvent = RuntimeEvent & { scope: Scope }

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

function project(event: StoredEvent): RuntimeEvent {
  const { scope: _, ...rest } = event
  return { ...rest }
}

const seqOf = (event: RuntimeEvent): bigint => BigInt(event.seq)

function dedupeKey(
  event: Pick<RuntimeEvent, 'runtimeSessionId' | 'generation' | 'source' | 'sourceEventId'>
): string {
  return `${event.runtimeSessionId}\u0000${event.generation}\u0000${event.source}\u0000${event.sourceEventId}`
}

export type SessionEventInput = Readonly<{
  runtimeSessionId: string
  generation: number
  harnessRunId?: string
  kind: RuntimeEventKind
  source?: RuntimeEvent['source']
  confidence?: RuntimeEvent['confidence']
  classification?: RuntimeEvent['classification']
  payload?: unknown
  sourceEventId: string
  occurredAt?: string
}>

export type SessionEventLog = Readonly<{
  /** Appends one event; an identical duplicate returns `undefined`. */
  append(input: SessionEventInput): RuntimeEvent | undefined
  /** Bounded ascending read from `fromSequence` (inclusive). */
  read(
    runtimeSessionId: string,
    options?: { fromSequence?: string; limit?: number; generation?: number }
  ): RuntimeEvent[]
  latestSequence(runtimeSessionId: string, generation?: number): string
  /** Live subscription for stream push; returns the unsubscribe fn. */
  subscribe(runtimeSessionId: string, cb: (event: RuntimeEvent) => void): () => void
  /** Test/ops introspection: the wire DTOs currently retained. */
  events(): readonly RuntimeEvent[]
}>

export function createSessionEventLog(input: {
  dataDir: string
  scope: Scope
  /** Overrides the per-session bound (tests only; production uses the constant). */
  maxPerSession?: number
  /** Overrides the total bound (tests only; production uses the constant). */
  maxTotal?: number
}): SessionEventLog {
  const maxPerSession = input.maxPerSession ?? MAX_EVENTS_PER_SESSION
  const maxTotal = input.maxTotal ?? MAX_TOTAL_EVENTS
  const store = createDurableJsonStore<StoredEvent>({
    file: join(input.dataDir, EVENTS_STORE_FILE),
    schemaVersion: 1,
    label: 'runtime session events',
  })
  const subscribers = new Map<string, Set<(event: RuntimeEvent) => void>>()

  const inScope = (): StoredEvent[] =>
    store.load().records.filter((event) => sameScope(event.scope, input.scope))

  function latestSeqOf(
    records: readonly RuntimeEvent[],
    runtimeSessionId: string,
    generation?: number
  ): string {
    const events = records
      .filter((event) => event.runtimeSessionId === runtimeSessionId)
      .filter((event) => (generation !== undefined ? event.generation === generation : true))
    return events.length === 0
      ? '0'
      : events.reduce((max, event) => (seqOf(event) > BigInt(max) ? event.seq : max), '0')
  }

  const all = (): RuntimeEvent[] => inScope().map(project)

  function appendEvent(sessionInput: SessionEventInput): RuntimeEvent | undefined {
    const records = all()
    const source = sessionInput.source ?? 'host'
    const candidate: RuntimeEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      runtimeSessionId: sessionInput.runtimeSessionId,
      ...(sessionInput.harnessRunId !== undefined
        ? { harnessRunId: sessionInput.harnessRunId }
        : {}),
      generation: sessionInput.generation,
      seq: (
        BigInt(latestSeqOf(records, sessionInput.runtimeSessionId, sessionInput.generation)) + 1n
      ).toString(),
      occurredAt: sessionInput.occurredAt ?? new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      source,
      sourceEventId: sessionInput.sourceEventId,
      confidence: sessionInput.confidence ?? 'authoritative',
      classification: sessionInput.classification ?? 'workspace_metadata',
      kind: sessionInput.kind,
      payload: sessionInput.payload ?? {},
    }
    const duplicate = records.find((event) => dedupeKey(event) === dedupeKey(candidate))
    if (duplicate) {
      if (
        duplicate.kind === candidate.kind &&
        JSON.stringify(duplicate.payload) === JSON.stringify(candidate.payload)
      ) {
        return undefined
      }
      throw {
        code: 'idempotency_conflict',
        retryable: false,
        message:
          'a different event already exists under this (session, generation, source, sourceEventId) key',
      }
    }
    // Retention: oldest-first per session beyond the per-session bound, then
    // a total bound across the scope so the durable file stays bounded.
    const sessionEvents = records.filter(
      (event) => event.runtimeSessionId === sessionInput.runtimeSessionId
    )
    let bounded = records
    if (sessionEvents.length + 1 > maxPerSession) {
      const evict = new Set(
        sessionEvents
          .toSorted((left, right) => (seqOf(left) < seqOf(right) ? -1 : 1))
          .slice(0, sessionEvents.length + 1 - maxPerSession)
          .map((event) => event.eventId)
      )
      bounded = bounded.filter((event) => !evict.has(event.eventId))
    }
    bounded = [...bounded, candidate]
    if (bounded.length > maxTotal) {
      bounded = bounded
        .toSorted((left, right) => (seqOf(left) < seqOf(right) ? -1 : 1))
        .slice(bounded.length - maxTotal)
    }
    // Persist: this scope's bounded window plus every other-scope record,
    // untouched (one durable file serves the host; scopes never mix).
    const otherScopeRecords = store
      .load()
      .records.filter((event) => !sameScope(event.scope, input.scope))
    const stored: StoredEvent[] = [
      ...otherScopeRecords,
      ...bounded.map((event) => ({ ...event, scope: input.scope })),
    ]
    store.save(stored)
    for (const cb of subscribers.get(sessionInput.runtimeSessionId) ?? []) cb(candidate)
    return candidate
  }

  function readEvents(
    runtimeSessionId: string,
    options?: { fromSequence?: string; limit?: number; generation?: number }
  ): RuntimeEvent[] {
    const limit = Math.min(options?.limit ?? EVENT_PAGE_DEFAULT, EVENT_PAGE_MAX)
    const from = BigInt(options?.fromSequence ?? '0')
    return all()
      .filter((event) => event.runtimeSessionId === runtimeSessionId)
      .filter((event) =>
        options?.generation !== undefined ? event.generation === options.generation : true
      )
      .filter((event) => seqOf(event) >= from)
      .toSorted((left, right) => (seqOf(left) < seqOf(right) ? -1 : 1))
      .slice(0, limit)
  }

  return {
    append: appendEvent,
    read: readEvents,
    latestSequence(runtimeSessionId, generation) {
      return latestSeqOf(all(), runtimeSessionId, generation)
    },
    subscribe(runtimeSessionId, cb) {
      const set = subscribers.get(runtimeSessionId) ?? new Set()
      set.add(cb)
      subscribers.set(runtimeSessionId, set)
      return () => {
        set.delete(cb)
      }
    },
    events: all,
  }
}
