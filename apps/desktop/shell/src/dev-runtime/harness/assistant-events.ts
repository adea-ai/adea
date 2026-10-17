import {
  decodeRuntimeAssistantPayload,
  encodeCbor,
  isRuntimeAssistantEventKind,
  type RuntimeEvent,
} from '../../../../../../packages/types/src/dev-runtime-wire'

/** The `runtime-events-v1` grant limit: one canonical-CBOR event per frame. */
export const RUNTIME_EVENT_FRAME_BYTES_MAX = 65_536

/**
 * Refuse an assistant event whose canonical-CBOR encoding cannot be streamed.
 * Call it on the exact event to be stored (final sequence included) before
 * persistence or publication: JSON size is no proxy, because CBOR expands
 * numbers (a 3-byte `0.1` becomes 9) and the envelope adds its own bytes.
 * Nothing is truncated; the append fails and consumes no sequence.
 */
export function assertAssistantEventFitsFrame(event: RuntimeEvent): void {
  if (
    isRuntimeAssistantEventKind(event.kind) &&
    encodeCbor(event).byteLength > RUNTIME_EVENT_FRAME_BYTES_MAX
  )
    throw new TypeError(
      `event: maximum encoded assistant event size exceeded (${RUNTIME_EVENT_FRAME_BYTES_MAX} bytes)`
    )
}

const confidenceRank = { untrusted_hint: 0, bounded_projection: 1, authoritative: 2 } as const

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
    // A legacy row's messageId alone is not identity evidence. Validate the
    // kind-specific payload before it can establish any lifecycle fence.
    try {
      return (
        decodeRuntimeAssistantPayload(event.kind, event.payload).messageId === payload.messageId
      )
    } catch {
      return false
    }
  })
  if (
    sameMessage.some(
      (event) => confidenceRank[event.confidence] > confidenceRank[candidate.confidence]
    )
  ) {
    throw {
      code: 'invalid_state',
      retryable: false,
      message: 'a weaker assistant observation cannot replace or close stronger text',
    }
  }
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
