// Producer admission only. M11 remains the response/approval authority; this
// module never accepts renderer commands, grants input ownership, or answers a
// harness. All facts arrive from the owning authenticated event adapter.
import type {
  DevError,
  DevErrorCode,
  RuntimeEvent,
  RuntimeSession,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import {
  decodeRuntimeInteractionPayload,
  runtimeInteractionKinds,
  snapshotRuntimeInteractionValue,
  validateRuntimeQuestionAnswers,
  type RuntimeInteractionPayload,
} from '../../../../../../packages/types/src/dev-runtime-interactions'
import { decodeRuntimeEvent } from '../../../../../../packages/types/src/dev-runtime-wire'

function refuse(code: DevErrorCode, message: string): never {
  throw { code, message, retryable: false } satisfies DevError
}

type InteractionAdmission = Readonly<{
  event: RuntimeEvent
  payload: RuntimeInteractionPayload
  session: RuntimeSession
}>

/** Freeze even opaque legacy interaction JSON before storage can serialize it. */
export function snapshotInteractionEvent(event: RuntimeEvent): RuntimeEvent | undefined {
  if (!(runtimeInteractionKinds as readonly string[]).includes(event.kind)) return undefined
  const data = snapshotRuntimeInteractionValue(event.payload)
  const payload = decodeRuntimeInteractionPayload(event.kind, data) ?? data
  return Object.freeze({ ...event, payload })
}

export function validateInteractionAdmission(
  event: RuntimeEvent,
  scope: Scope,
  resolveSession?: (id: string) => RuntimeSession | undefined
): InteractionAdmission | undefined {
  const payload = decodeRuntimeInteractionPayload(event.kind, event.payload)
  if (!payload) return undefined
  const snapshot = Object.freeze({ ...event, payload })
  decodeRuntimeEvent(snapshot, { source: snapshot.source })
  if (!resolveSession)
    refuse(
      'capability_unavailable',
      'structured interactions require the canonical session authority'
    )
  const session = resolveSession(event.runtimeSessionId)
  if (!session) refuse('not_found', 'runtime session not found')
  if (
    session.id !== event.runtimeSessionId ||
    session.scope.accountId !== scope.accountId ||
    session.scope.workspaceId !== scope.workspaceId ||
    session.scope.runtimeNodeId !== scope.runtimeNodeId
  )
    refuse('identity_mismatch', 'interaction belongs to another runtime session or scope')
  if (session.generation !== event.generation)
    refuse('stale_generation', 'interaction generation does not match the canonical session')
  if (session.archived) refuse('invalid_state', 'archived sessions cannot admit interactions')
  if (session.activeHarnessRunId !== event.harnessRunId)
    refuse('identity_mismatch', 'interaction does not name the current harness run')
  return { event: snapshot, payload, session }
}

export function validateInteractionCorrelation(
  event: RuntimeEvent,
  admission: InteractionAdmission,
  records: readonly RuntimeEvent[]
): void {
  const { payload, session } = admission
  const sameRun = records.filter(
    (record) =>
      record.runtimeSessionId === event.runtimeSessionId &&
      record.generation === event.generation &&
      record.harnessRunId === event.harnessRunId
  )
  if (event.kind.endsWith('.requested')) {
    // Exact replays have already returned from the log. Terminal state only
    // fences a new request, not an idempotent replay of a retained request.
    if (session.lifecycle !== 'ready' && session.lifecycle !== 'active')
      refuse('invalid_state', 'runtime session cannot open a new interaction in its current state')
    if (
      sameRun.some(
        (record) =>
          record.kind.endsWith('.requested') &&
          decodeRuntimeInteractionPayload(record.kind, record.payload)?.requestId ===
            payload.requestId
      )
    )
      refuse('idempotency_conflict', 'interaction request id already names another canonical event')
    return
  }
  if (!('requestEventId' in payload))
    refuse('invalid_state', 'interaction outcome requires its request event')
  const requested = sameRun.find((record) => record.eventId === payload.requestEventId)
  if (!requested)
    refuse('resync_required', 'interaction request is not in the retained event window')
  const requestKind = event.kind.startsWith('approval.')
    ? 'approval.requested'
    : 'question.requested'
  const requestPayload = decodeRuntimeInteractionPayload(requested.kind, requested.payload)
  if (
    requested.kind !== requestKind ||
    !requestPayload ||
    requestPayload.requestId !== payload.requestId ||
    requested.source !== event.source
  )
    refuse(
      'identity_mismatch',
      'interaction outcome does not match its request kind, id, or source'
    )
  // A new source event cannot answer/expire an already closed request. The
  // event log handles exact source-event replay before reaching this check.
  if (
    sameRun.some((record) => {
      if (!record.kind.endsWith('.resolved') && !record.kind.endsWith('.expired')) return false
      const previous = decodeRuntimeInteractionPayload(record.kind, record.payload)
      return (
        previous && 'requestEventId' in previous && previous.requestEventId === requested.eventId
      )
    })
  )
    refuse('already_completed', 'interaction request already has a canonical outcome')
  if (event.kind === 'question.resolved') validateRuntimeQuestionAnswers(requestPayload, payload)
}
