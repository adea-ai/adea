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
  RuntimeSession,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { canonicalDevCommandJson } from '../../../../../../packages/types/src/dev-runtime'
import { validateRuntimeResponseReferences } from '../../../../../../packages/types/src/dev-runtime-response-references'
import { createDurableJsonStore } from '../host-store'
import { validateInteractionAdmission, validateInteractionCorrelation } from './interactions'
import { assertAssistantEventFitsFrame, assertAssistantEventOrder } from './assistant-events'
import {
  decodeRuntimeEvent,
  validateRuntimeEventReplayCandidate,
  isRuntimeAssistantEventKind,
  isRuntimeCallEventKind,
} from '../../../../../../packages/types/src/dev-runtime-wire'
import {
  snapshotCallEvent,
  validateCallEventAdmission,
  type VerifyCallPermissionEligibility,
} from './call-events'
import {
  assertVisibleSummaryAppend,
  assertVisibleSummaryReplay,
  type VisibleSummaryVerifier,
} from './visible-summaries'

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
  validateRuntimeResponseReferences(rest.kind, rest.payload, rest.source)
  return { ...rest }
}

const seqOf = (event: RuntimeEvent): bigint => BigInt(event.seq)

function isVersionedCall(event: RuntimeEvent): boolean {
  return (
    isRuntimeCallEventKind(event.kind) &&
    event.payload !== null &&
    typeof event.payload === 'object' &&
    Object.hasOwn(event.payload, 'schemaVersion')
  )
}

function compareRetentionOrder(left: RuntimeEvent, right: RuntimeEvent): number {
  if (left.generation !== right.generation) return left.generation < right.generation ? -1 : 1
  const leftSequence = seqOf(left)
  const rightSequence = seqOf(right)
  if (leftSequence !== rightSequence) return leftSequence < rightSequence ? -1 : 1
  return left.eventId.localeCompare(right.eventId)
}

function sameSourceEvent(
  left: Pick<RuntimeEvent, 'runtimeSessionId' | 'generation' | 'source' | 'sourceEventId'>,
  right: Pick<RuntimeEvent, 'runtimeSessionId' | 'generation' | 'source' | 'sourceEventId'>
): boolean {
  return (
    left.runtimeSessionId === right.runtimeSessionId &&
    left.generation === right.generation &&
    left.source === right.source &&
    left.sourceEventId === right.sourceEventId
  )
}

export type SessionEventInput = Readonly<{
  runtimeSessionId: string
  generation: number
  harnessRunId?: string
  kind: RuntimeEventKind
  source?: RuntimeEvent['source']
  confidence?: RuntimeEvent['confidence']
  /** Required for call events; other event kinds retain the metadata default. */
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
  /** The existing session authority. Required for versioned interactions;
   * legacy opaque events remain readable without inventing that authority. */
  resolveSession?: (runtimeSessionId: string) => RuntimeSession | undefined
  /** Overrides the per-session bound (tests only; production uses the constant). */
  maxPerSession?: number
  /** Overrides the total bound (tests only; production uses the constant). */
  maxTotal?: number
  /** No production adapter supplies this yet; absent evidence means unknown only. */
  verifyCallPermissionEligibility?: VerifyCallPermissionEligibility
  /** Requires genuine authenticated source observations; absent fails closed. */
  verifyVisibleSummary?: VisibleSummaryVerifier
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

  const all = (): RuntimeEvent[] => {
    const records = inScope().map(project)
    assertVisibleSummaryReplay(records)
    return records
  }

  function appendEvent(sessionInput: SessionEventInput): RuntimeEvent | undefined {
    validateRuntimeResponseReferences(
      sessionInput.kind,
      sessionInput.payload,
      sessionInput.source ?? 'host'
    )
    const records = all()
    const source = sessionInput.source ?? 'host'
    const latest = BigInt(
      latestSeqOf(records, sessionInput.runtimeSessionId, sessionInput.generation)
    )
    const exhausted = latest >= 18_446_744_073_709_551_615n
    const nextSeq = (exhausted ? latest : latest + 1n).toString()
    let candidate: RuntimeEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      runtimeSessionId: sessionInput.runtimeSessionId,
      ...(sessionInput.harnessRunId !== undefined
        ? { harnessRunId: sessionInput.harnessRunId }
        : {}),
      generation: sessionInput.generation,
      // The stored cursor is the next one, so call verifiers and frame budgets
      // see the real event. An exhausted generation keeps its last valid cursor
      // here, so an exact retry stays a no-op; a new event is refused below.
      seq: nextSeq,
      occurredAt: sessionInput.occurredAt ?? new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      source,
      sourceEventId: sessionInput.sourceEventId,
      confidence: sessionInput.confidence ?? 'authoritative',
      classification: sessionInput.classification ?? 'workspace_metadata',
      kind: sessionInput.kind,
      payload: sessionInput.payload ?? {},
    }
    const interaction = validateInteractionAdmission(candidate, input.scope, input.resolveSession)
    if (isVersionedCall(candidate) && sessionInput.classification === undefined)
      throw new TypeError('event.classification: call observations require explicit classification')
    // A retry does not create a new call envelope: validate call facts before
    // comparison and charge the frame budget only for a genuinely new call.
    // Assistant events are checked here too, so a malformed identity never
    // reaches dedupe or the cursor. Other kinds keep legacy opaque retention.
    if (isRuntimeCallEventKind(candidate.kind) || isRuntimeAssistantEventKind(candidate.kind))
      validateRuntimeEventReplayCandidate(candidate, { source })
    const duplicate = records.find((event) => sameSourceEvent(event, candidate))
    if (duplicate) {
      // Calls and assistant messages are keyed by their producing run and
      // confidence; legacy opaque kinds keep their lenient retry comparison.
      const sameMetadata =
        !(isVersionedCall(candidate) || isRuntimeAssistantEventKind(candidate.kind)) ||
        (duplicate.harnessRunId === candidate.harnessRunId &&
          duplicate.confidence === candidate.confidence &&
          duplicate.classification === candidate.classification &&
          (sessionInput.occurredAt === undefined || duplicate.occurredAt === candidate.occurredAt))
      if (
        duplicate.kind === candidate.kind &&
        (!interaction || duplicate.harnessRunId === candidate.harnessRunId) &&
        (isVersionedCall(candidate)
          ? JSON.stringify(duplicate.payload) === JSON.stringify(candidate.payload)
          : canonicalDevCommandJson(duplicate.payload) ===
            canonicalDevCommandJson(candidate.payload)) &&
        sameMetadata
      ) {
        if (isVersionedCall(candidate)) {
          const replay = snapshotCallEvent(duplicate)
          validateCallEventAdmission(replay, records, input.verifyCallPermissionEligibility)
        }
        return undefined
      }
      throw {
        code: 'idempotency_conflict',
        retryable: false,
        message:
          'a different event already exists under this (session, generation, source, sourceEventId) key',
      }
    }
    if (interaction) validateInteractionCorrelation(candidate, interaction, records)

    if (isRuntimeCallEventKind(candidate.kind)) {
      decodeRuntimeEvent(candidate, { source })
      candidate = snapshotCallEvent(candidate)
      validateCallEventAdmission(candidate, records, input.verifyCallPermissionEligibility)
    }
    assertVisibleSummaryAppend(candidate, records, input.scope, input.verifyVisibleSummary)
    assertAssistantEventOrder(records, candidate)
    if (exhausted) {
      throw {
        code: 'invalid_state',
        retryable: false,
        message: 'runtime event sequence exhausted for this generation',
      }
    }
    // Size the exact stored event: the allocated sequence can add a digit.
    assertAssistantEventFitsFrame(candidate)
    // Retention: oldest-first per session beyond the per-session bound, then
    // a total bound across the scope so the durable file stays bounded.
    const sessionEvents = records.filter(
      (event) => event.runtimeSessionId === sessionInput.runtimeSessionId
    )
    let bounded = records
    if (sessionEvents.length + 1 > maxPerSession) {
      const evict = new Set(
        sessionEvents
          .toSorted(compareRetentionOrder)
          .slice(0, sessionEvents.length + 1 - maxPerSession)
          .map((event) => event.eventId)
      )
      bounded = bounded.filter((event) => !evict.has(event.eventId))
    }
    bounded = [...bounded, candidate]
    if (bounded.length > maxTotal) {
      bounded = bounded.toSorted(compareRetentionOrder).slice(bounded.length - maxTotal)
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
      .toSorted(compareRetentionOrder)
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
