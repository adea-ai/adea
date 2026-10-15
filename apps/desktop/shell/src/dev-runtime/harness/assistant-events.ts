import {
  decodeRuntimeAssistantPayload,
  isRuntimeAssistantEventKind,
  type RuntimeEvent,
} from '../../../../../../packages/types/src/dev-runtime-wire'

/** Guard new appends, not replay reads: a replay may legitimately start at a final. */
export function assertAssistantEventOrder(
  records: readonly RuntimeEvent[],
  candidate: RuntimeEvent
): void {
  if (!isRuntimeAssistantEventKind(candidate.kind)) return
  const payload = decodeRuntimeAssistantPayload(candidate.kind, candidate.payload)
  const sameMessage = records.filter((event) => {
    if (
      event.runtimeSessionId !== candidate.runtimeSessionId ||
      event.generation !== candidate.generation ||
      event.harnessRunId !== candidate.harnessRunId ||
      event.source !== candidate.source ||
      !isRuntimeAssistantEventKind(event.kind)
    )
      return false
    // Legacy opaque records cannot establish identity or supersession.
    return (event.payload as { messageId?: unknown } | null)?.messageId === payload.messageId
  })
  if (sameMessage.some((event) => event.kind === 'turn.result')) {
    throw {
      code: 'invalid_state',
      retryable: false,
      message: 'assistant message already has a result',
    }
  }
  const settled = sameMessage.some((event) => event.kind === 'turn.assistant_message')
  if (candidate.kind === 'turn.result') return
  if (settled) {
    throw {
      code: 'invalid_state',
      retryable: false,
      message: 'final assistant message already superseded its deltas',
    }
  }
  if (candidate.kind !== 'turn.assistant_delta') return
  const delta = decodeRuntimeAssistantPayload(candidate.kind, candidate.payload)
  const indexes = sameMessage
    .filter((event) => event.kind === 'turn.assistant_delta')
    .map((event) => decodeRuntimeAssistantPayload('turn.assistant_delta', event.payload).deltaIndex)
  const expectedIndex = indexes.length === 0 ? 0 : Math.max(...indexes) + 1
  if (delta.deltaIndex < expectedIndex) {
    throw {
      code: 'idempotency_conflict',
      retryable: false,
      message: 'assistant delta index already exists; retry with its original sourceEventId',
    }
  }
  if (delta.deltaIndex !== expectedIndex) {
    throw {
      code: 'resync_required',
      retryable: true,
      message: 'assistant delta gap; recover missing source events before appending',
    }
  }
}
