// Conversation restoration is an authenticated host operation, never a PTY
// rewind or a transcript edit. Production has no restore adapter yet.
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  decodeDevCommand,
  type DevCommand,
  type DevError,
  type DevErrorCode,
  type RuntimeEvent,
  type RuntimeSession,
  type Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import {
  decodeConversationCheckpoint,
  decodeCheckpointRestoreRequest,
  decodeCheckpointRestoreOutcome,
  type ConversationCheckpoint,
  type CheckpointRestoreRequest,
  type CheckpointRestoreOutcome,
} from '../../../../../../packages/types/src/dev-runtime-checkpoints'
import { decodeRuntimeEvent } from '../../../../../../packages/types/src/dev-runtime-wire'
import { devErrorCodes } from '../../../../../../packages/types/src/dev-runtime-errors'
import {
  exactKeys,
  integerValue,
  record,
  sha256Pattern,
  stringValue,
  timestamp,
} from '../../../../../../packages/types/src/dev-runtime-validation-internal'
import { createDurableSqliteStore } from '../host-store'
import type { SessionEventLog } from './events'

export type CheckpointRestoreAdapter = Readonly<{
  installationId: string
  source: 'native' | 'acp'
  /** Must call assertCurrent immediately before its generation-bound side effect.
   * A returned receipt means an observed restore, never mere command delivery. */
  restore(
    input: Readonly<{
      restoreId: string
      checkpoint: ConversationCheckpoint
      checkpointEvent: RuntimeEvent
      session: RuntimeSession
      assertCurrent(): void
      signal: AbortSignal
    }>
  ): Promise<
    Readonly<{
      status: 'restored'
      restoreId: string
      expectedGeneration: number
      runtimeSessionId: string
      harnessRunId: string
      checkpointId: string
      providerRestoreId: string
      observedAt: string
    }>
  >
}>
type AuditRecord = Readonly<{
  phase: 'requested' | 'outcome' | 'session_committed' | 'published_requested' | 'published_outcome'
  request: CheckpointRestoreRequest
  runtimeSessionId: string
  harnessRunId: string
  harnessInstallationId: string
  sessionVersion: number
  keyHash: string
  bodyHash: string
  outcome?: CheckpointRestoreOutcome
}>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function refuse(code: DevErrorCode, message: string): never {
  throw { code, message, retryable: false } satisfies DevError
}
function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.accountId === b.accountId &&
    a.workspaceId === b.workspaceId &&
    a.runtimeNodeId === b.runtimeNodeId
  )
}

function validateJournal(entries: readonly AuditRecord[]): void {
  const requests = new Map<string, AuditRecord>()
  const outcomes = new Map<string, CheckpointRestoreOutcome>()
  const phases = new Set<string>()
  const keys = new Set<string>()
  for (const value of entries) {
    const item = record(value, 'checkpoint journal')
    const terminal =
      item.phase === 'outcome' ||
      item.phase === 'published_outcome' ||
      item.phase === 'session_committed'
    exactKeys(
      item,
      [
        'phase',
        'request',
        'runtimeSessionId',
        'harnessRunId',
        'harnessInstallationId',
        'sessionVersion',
        'keyHash',
        'bodyHash',
        ...(terminal ? ['outcome'] : []),
      ],
      [],
      'checkpoint journal'
    )
    if (
      ![
        'requested',
        'outcome',
        'session_committed',
        'published_requested',
        'published_outcome',
      ].includes(item.phase as string)
    )
      throw new TypeError('unknown checkpoint journal phase')
    for (const key of ['runtimeSessionId', 'harnessRunId', 'harnessInstallationId'])
      stringValue(item[key], `journal.${key}`, 1, 256)
    for (const key of ['keyHash', 'bodyHash'])
      if (!sha256Pattern.test(stringValue(item[key], `journal.${key}`)))
        throw new TypeError('invalid journal digest')
    integerValue(item.sessionVersion, 'journal.sessionVersion', 0)
    const request = decodeCheckpointRestoreRequest(item.request)
    const phaseKey = `${request.restoreId}:${item.phase}`
    if (phases.has(phaseKey)) throw new TypeError('duplicate checkpoint journal phase')
    phases.add(phaseKey)
    if (item.phase === 'requested') {
      if (keys.has(value.keyHash)) throw new TypeError('duplicate checkpoint idempotency key')
      keys.add(value.keyHash)
      requests.set(request.restoreId, value)
    } else {
      const prior = requests.get(request.restoreId)
      if (
        !prior ||
        Object.entries(prior).some(
          ([key, entry]) => key !== 'phase' && JSON.stringify(item[key]) !== JSON.stringify(entry)
        )
      )
        throw new TypeError('checkpoint journal binding changed')
      if (terminal) {
        const outcome = decodeCheckpointRestoreOutcome(item.outcome)
        for (const key of [
          'restoreId',
          'checkpointId',
          'checkpointEventId',
          'requestedGeneration',
        ] as const)
          if (outcome[key] !== request[key])
            throw new TypeError('checkpoint outcome binding changed')
        if (item.phase === 'outcome') outcomes.set(request.restoreId, outcome)
        else if (JSON.stringify(outcomes.get(request.restoreId)) !== JSON.stringify(outcome))
          throw new TypeError('checkpoint completion without its original outcome')
        if (item.phase === 'session_committed' && outcome.status !== 'resolved')
          throw new TypeError('session commit without confirmed restore')
      }
    }
  }
}

export function createConversationCheckpointRuntime(input: {
  dataDir: string
  scope: Scope
  events: SessionEventLog
  resolveSession(id: string): RuntimeSession | undefined
  /** A restore ID must be witnessed in the same durable session transaction. */
  persistSession(session: RuntimeSession, restoreId?: string): void
  getSessionRestoreCommit?(restoreId: string):
    | Readonly<{
        runtimeSessionId: string
        generation: number
        version: number
      }>
    | undefined
  adapter?: CheckpointRestoreAdapter
  now?: () => number
  /** Tests may shorten the bound, never extend the production 30-second limit. */
  restoreTimeoutMs?: number
}) {
  const now = input.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  const store = createDurableSqliteStore<AuditRecord>({
    file: join(
      input.dataDir,
      'dev-runtime',
      'harness',
      'checkpoint-restores',
      `${hash([input.scope.accountId, input.scope.workspaceId, input.scope.runtimeNodeId])}.sqlite3`
    ),
    schemaVersion: 1,
    label: 'conversation checkpoint restore audit',
    scope: input.scope,
    validateRecords: validateJournal,
  })
  const read = () => store.load().records
  const append = (entry: AuditRecord) => {
    const entries = [...read(), entry]
    validateJournal(entries)
    store.save(entries)
  }
  const inFlight = new Map<string, Promise<CheckpointRestoreOutcome>>()
  const outcomeFor = (id: string) =>
    read().find((entry) => entry.phase === 'outcome' && entry.request.restoreId === id)?.outcome
  const sessionCommitted = (id: string) =>
    read().some((entry) => entry.phase === 'session_committed' && entry.request.restoreId === id)
  const result = (outcome: CheckpointRestoreOutcome): CheckpointRestoreOutcome => {
    if (outcome.status === 'failed')
      refuse(outcome.code, 'conversation checkpoint restore failed; see its canonical outcome')
    return outcome
  }
  // Confirmation is the write-ahead decision for the separate session store.
  // Reapplying it after a crash must neither dispatch again nor overwrite a
  // session whose owner/version changed while persistence was interrupted.
  function completeSession(entry: AuditRecord, outcome: CheckpointRestoreOutcome): boolean {
    if (outcome.status !== 'resolved') return true
    if (sessionCommitted(entry.request.restoreId)) return true
    const commit = input.getSessionRestoreCommit?.(entry.request.restoreId)
    if (commit) {
      if (
        commit.runtimeSessionId !== entry.runtimeSessionId ||
        commit.generation !== outcome.restoredGeneration ||
        commit.version !== entry.sessionVersion + 1
      )
        refuse('corrupt_state', 'checkpoint session commit identity changed')
      append({ ...entry, phase: 'session_committed', outcome })
      return true
    }
    const current = input.resolveSession(entry.runtimeSessionId)
    if (!current || current.id !== entry.runtimeSessionId || !sameScope(current.scope, input.scope))
      return false
    if (
      current.generation !== entry.request.requestedGeneration ||
      current.version !== entry.sessionVersion ||
      current.activeHarnessRunId !== entry.harnessRunId ||
      current.harnessInstallationId !== entry.harnessInstallationId ||
      current.archived
    )
      return false
    input.persistSession(
      {
        ...current,
        generation: outcome.restoredGeneration,
        version: current.version + 1,
      },
      entry.request.restoreId
    )
    if (!input.getSessionRestoreCommit?.(entry.request.restoreId))
      refuse('corrupt_state', 'restore session write has no atomic commit witness')
    return completeSession(entry, outcome)
  }
  function publish(entry: AuditRecord): void {
    const phase = entry.phase === 'requested' ? 'requested' : 'outcome'
    if (
      read().some(
        (item) =>
          item.request.restoreId === entry.request.restoreId && item.phase === `published_${phase}`
      )
    )
      return
    const payload = phase === 'requested' ? entry.request : entry.outcome!
    input.events.append({
      runtimeSessionId: entry.runtimeSessionId,
      harnessRunId: entry.harnessRunId,
      generation: entry.request.requestedGeneration,
      source: 'host',
      confidence: 'authoritative',
      classification: 'workspace_private',
      kind:
        phase === 'requested'
          ? 'checkpoint.restore_requested'
          : entry.outcome!.status === 'resolved'
            ? 'checkpoint.restore_resolved'
            : 'checkpoint.restore_failed',
      sourceEventId: `host:checkpoint-restore:${entry.request.restoreId}:${phase}`,
      payload,
      occurredAt: phase === 'requested' ? entry.request.requestedAt : entry.outcome!.completedAt,
    })
    append({ ...entry, phase: `published_${phase}` })
  }
  function finish(entry: AuditRecord, outcome: CheckpointRestoreOutcome): CheckpointRestoreOutcome {
    const existing = outcomeFor(entry.request.restoreId)
    if (existing) return existing
    decodeCheckpointRestoreOutcome(outcome)
    const completed: AuditRecord = { ...entry, phase: 'outcome', outcome }
    append(completed)
    if (!completeSession(entry, outcome))
      refuse('stale_generation', 'confirmed restore session ownership changed')
    publish(entry)
    publish(completed)
    return outcome
  }
  function failed(entry: AuditRecord, code: DevErrorCode): CheckpointRestoreOutcome {
    const { requestedAt: _, ...identity } = entry.request
    return finish(entry, { ...identity, status: 'failed', code, completedAt: iso() })
  }
  // The journal is the durable outbox. A restart never redelivers an ambiguous
  // harness side effect, and publication markers avoid replaying evicted audit.
  for (const entry of read().filter((item) => item.phase === 'requested')) {
    if (!outcomeFor(entry.request.restoreId)) failed(entry, 'delivery_ambiguous')
  }
  for (const entry of read().filter(
    (item) => item.phase === 'requested' || item.phase === 'outcome'
  )) {
    if (entry.phase === 'outcome' && !completeSession(entry, entry.outcome!)) continue
    publish(entry)
  }

  function sessionFor(id: string): RuntimeSession {
    const session = input.resolveSession(id)
    if (!session) refuse('not_found', 'runtime session not found')
    if (session.id !== id || !sameScope(session.scope, input.scope))
      refuse('identity_mismatch', 'checkpoint session belongs to another authority scope')
    return session
  }
  function observe(value: {
    runtimeSessionId: string
    expectedGeneration: number
    checkpointId: string
    name: string
    createdAt: string
    sourceEventId: string
  }): RuntimeEvent | undefined {
    stringValue(value.sourceEventId, 'checkpoint.sourceEventId', 1, 256)
    const session = sessionFor(value.runtimeSessionId)
    if (session.generation !== value.expectedGeneration)
      refuse('stale_generation', 'checkpoint observation has a stale generation')
    if (session.archived || !session.activeHarnessRunId || !session.harnessInstallationId)
      refuse('invalid_state', 'checkpoint observation requires a current harness session')
    const supported =
      input.adapter?.installationId === session.harnessInstallationId &&
      input.getSessionRestoreCommit !== undefined
    const payload = decodeConversationCheckpoint({
      schemaVersion: 1,
      checkpointId: value.checkpointId,
      name: value.name,
      createdAt: value.createdAt,
      harnessInstallationId: session.harnessInstallationId,
      restore: supported
        ? { supported: true }
        : { supported: false, reason: 'harness_restore_unavailable' },
    })
    return input.events.append({
      runtimeSessionId: session.id,
      harnessRunId: session.activeHarnessRunId,
      generation: session.generation,
      source: supported ? input.adapter!.source : 'host',
      sourceEventId: value.sourceEventId,
      kind: 'checkpoint.observed',
      confidence: 'authoritative',
      classification: 'workspace_private',
      payload,
      occurredAt: value.createdAt,
    })
  }
  async function restore(raw: DevCommand): Promise<CheckpointRestoreOutcome> {
    const command = decodeDevCommand(raw)
    if (command.operation !== 'dev.session.restoreCheckpoint')
      refuse('invalid_state', 'wrong checkpoint operation')
    if (!sameScope(command.scope, input.scope))
      refuse('identity_mismatch', 'restore scope is not authorized')
    if (Date.parse(command.expiresAt) <= now())
      refuse('token_expired', 'restore command has expired')
    if (!command.idempotencyKey) refuse('invalid_state', 'restore requires an idempotency key')
    const body = command.body as {
      runtimeSessionId: string
      expectedGeneration: number
      checkpointEventId: string
    }
    const session = sessionFor(body.runtimeSessionId)
    const resource = command.resource
    if (
      !resource ||
      resource.kind !== 'runtime_session' ||
      resource.id !== session.id ||
      resource.generation !== body.expectedGeneration
    )
      refuse('identity_mismatch', 'restore resource does not match its session/generation')
    const keyHash = hash(command.idempotencyKey)
    const bodyHash = hash([body.runtimeSessionId, body.expectedGeneration, body.checkpointEventId])
    const entries = read()
    const existing = entries.find(
      (entry) => entry.phase === 'requested' && entry.keyHash === keyHash
    )
    if (existing) {
      if (existing.bodyHash !== bodyHash)
        refuse('idempotency_conflict', 'restore key was already used for another request')
      const pending = inFlight.get(keyHash)
      if (pending) return pending
      const outcome = outcomeFor(existing.request.restoreId)
      if (!outcome)
        refuse('delivery_ambiguous', 'restore is interrupted; restart recovery is required')
      if (!completeSession(existing, outcome))
        refuse('stale_generation', 'confirmed restore session ownership changed')
      const expected =
        outcome.status === 'resolved'
          ? outcome.restoredGeneration
          : existing.request.requestedGeneration
      if (sessionFor(session.id).generation !== expected)
        refuse('stale_generation', 'restore replay is no longer current')
      publish(existing)
      publish({ ...existing, phase: 'outcome', outcome })
      return result(outcome)
    }
    if (session.generation !== body.expectedGeneration)
      refuse('stale_generation', 'restore generation is stale')
    if (
      session.archived ||
      !['ready', 'active'].includes(session.lifecycle) ||
      !session.activeHarnessRunId ||
      !session.harnessInstallationId
    )
      refuse('invalid_state', 'restore requires a live, unarchived harness session')
    const requests = entries.filter((item) => item.phase === 'requested')
    const committedIds = new Set(
      entries
        .filter((item) => item.phase === 'session_committed')
        .map((item) => item.request.restoreId)
    )
    const completedIds = new Set(
      entries
        .filter(
          (item) =>
            item.phase === 'outcome' &&
            (item.outcome!.status === 'failed' || committedIds.has(item.request.restoreId))
        )
        .map((item) => item.request.restoreId)
    )
    if (requests.length >= 1000)
      refuse('limit_exceeded', 'checkpoint restore audit capacity reached')
    if (
      requests.some(
        (entry) =>
          entry.phase === 'requested' &&
          entry.runtimeSessionId === session.id &&
          !completedIds.has(entry.request.restoreId)
      )
    )
      refuse('invalid_state', 'a restore is already in progress for this session')
    const checkpointEvent = input.events
      .events()
      .find((event) => event.eventId === body.checkpointEventId)
    if (!checkpointEvent) refuse('resync_required', 'checkpoint event is not retained')
    if (
      checkpointEvent.runtimeSessionId !== session.id ||
      checkpointEvent.kind !== 'checkpoint.observed' ||
      checkpointEvent.generation > session.generation
    )
      refuse('identity_mismatch', 'checkpoint belongs to another session or event kind')
    decodeRuntimeEvent(checkpointEvent, { source: checkpointEvent.source })
    const checkpoint = decodeConversationCheckpoint(checkpointEvent.payload)
    if (checkpoint.harnessInstallationId !== session.harnessInstallationId)
      refuse('identity_mismatch', 'checkpoint belongs to another harness installation')
    const entry: AuditRecord = {
      phase: 'requested',
      runtimeSessionId: session.id,
      harnessRunId: session.activeHarnessRunId,
      harnessInstallationId: session.harnessInstallationId,
      sessionVersion: session.version,
      keyHash,
      bodyHash,
      request: {
        schemaVersion: 1,
        restoreId: randomUUID(),
        checkpointId: checkpoint.checkpointId,
        checkpointEventId: checkpointEvent.eventId,
        requestedGeneration: session.generation,
        requestedAt: iso(),
      },
    }
    append(entry)
    publish(entry)
    const assertCurrent = () => {
      const prior = outcomeFor(entry.request.restoreId)
      if (prior) {
        if (prior.status === 'failed') result(prior)
        refuse('already_completed', 'restore already completed')
      }
      const current = sessionFor(session.id)
      if (
        current.generation !== session.generation ||
        current.version !== session.version ||
        current.activeHarnessRunId !== session.activeHarnessRunId ||
        current.harnessInstallationId !== session.harnessInstallationId ||
        current.archived
      )
        refuse('stale_generation', 'restore session/input ownership changed')
      if (Date.parse(command.expiresAt) <= now())
        refuse('token_expired', 'restore command expired before its side effect')
    }
    const execute = async (): Promise<CheckpointRestoreOutcome> => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const adapter = input.adapter
        if (
          !adapter ||
          !input.getSessionRestoreCommit ||
          adapter.installationId !== session.harnessInstallationId ||
          !checkpoint.restore.supported
        )
          refuse(
            'capability_unavailable',
            'this harness has no verified conversation checkpoint restore adapter'
          )
        assertCurrent()
        let adapterFenced = false
        const receipt = await Promise.race([
          adapter.restore({
            restoreId: entry.request.restoreId,
            checkpoint,
            checkpointEvent,
            session,
            assertCurrent: () => {
              assertCurrent()
              adapterFenced = true
            },
            signal: controller.signal,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                controller.abort()
                reject({ code: 'delivery_ambiguous' })
              },
              Math.min(30_000, Math.max(1, input.restoreTimeoutMs ?? 30_000))
            )
          }),
        ])
        assertCurrent()
        const proof = record(receipt, 'restore receipt')
        exactKeys(
          proof,
          [
            'status',
            'restoreId',
            'expectedGeneration',
            'runtimeSessionId',
            'harnessRunId',
            'checkpointId',
            'providerRestoreId',
            'observedAt',
          ],
          [],
          'restore receipt'
        )
        if (
          proof.status !== 'restored' ||
          proof.restoreId !== entry.request.restoreId ||
          proof.expectedGeneration !== session.generation ||
          proof.runtimeSessionId !== session.id ||
          proof.harnessRunId !== session.activeHarnessRunId ||
          proof.checkpointId !== checkpoint.checkpointId
        )
          refuse(
            'identity_mismatch',
            'restore receipt does not confirm the requested checkpoint/session/run'
          )
        stringValue(proof.providerRestoreId, 'receipt.providerRestoreId', 1, 256)
        timestamp(proof.observedAt, 'receipt.observedAt')
        if (!adapterFenced)
          refuse('ownership_unproven', 'restore adapter did not prove its generation fence')
        const { requestedAt: _, ...identity } = entry.request
        const confirmed = decodeCheckpointRestoreOutcome({
          ...identity,
          status: 'resolved',
          restoredGeneration: session.generation + 1,
          providerRestoreId: receipt.providerRestoreId,
          restoredAt: receipt.observedAt,
          completedAt: iso(),
        })
        return result(finish(entry, confirmed))
      } catch (error) {
        const confirmed = outcomeFor(entry.request.restoreId)
        if (confirmed?.status === 'resolved') {
          // A durable confirmation cannot be replaced by a contradictory
          // failure. Publication may lag, but success requires the session
          // generation to have committed; otherwise recovery must finish it.
          if (
            input.getSessionRestoreCommit?.(entry.request.restoreId) &&
            completeSession(entry, confirmed)
          )
            return confirmed
          throw error
        }
        const code = (error as { code?: DevErrorCode })?.code
        return result(
          failed(entry, code && devErrorCodes.includes(code) ? code : 'delivery_ambiguous')
        )
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        controller.abort()
      }
    }
    const pending = execute().finally(() => {
      inFlight.delete(keyHash)
    })
    inFlight.set(keyHash, pending)
    return pending
  }
  return { observe, restore, journal: read }
}
