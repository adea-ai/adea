import {
  decodeCbor,
  decodeRuntimeEvent,
  type DevStreamFrame,
  type RuntimeEvent,
} from '@adea-ai/types/dev-runtime'

import type { ChatRetentionTruth } from './types'

export const CHAT_EVENT_RETENTION_LIMIT = 1_000

export type TranscriptAvailability =
  | Readonly<{ status: 'available' }>
  | Readonly<{
      status: 'bounded'
      reason: 'retention' | 'sequence_gap' | 'checkpoint_required'
      oldestSequence?: string
      requestedFromSequence?: string
    }>
  | Readonly<{
      status: 'resync_required'
      reason: 'sequence_gap'
      expectedSequence: string
      receivedSequence: string
    }>
  | Readonly<{ status: 'stale_generation'; generation: number }>
  | Readonly<{ status: 'conflict'; sourceEventId: string }>

export type TranscriptAccumulator = Readonly<{
  runtimeSessionId: string
  generation: number
  fromSequence: string
  expectedSequence?: string
  events: readonly RuntimeEvent[]
  availability: TranscriptAvailability
  retention: ChatRetentionTruth
}>

function sequence(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    return -1n
  }
}

function eventKey(event: RuntimeEvent): string {
  return `${event.runtimeSessionId}\u0000${event.generation}\u0000${event.source}\u0000${event.sourceEventId}`
}

function sameEvent(left: RuntimeEvent, right: RuntimeEvent): boolean {
  return (
    left.kind === right.kind &&
    left.seq === right.seq &&
    left.runtimeSessionId === right.runtimeSessionId &&
    left.generation === right.generation &&
    JSON.stringify(left.payload) === JSON.stringify(right.payload)
  )
}

function retention(
  events: readonly RuntimeEvent[],
  requestedFrom: string,
  reason?: ChatRetentionTruth['reason']
): ChatRetentionTruth {
  const ordered = [...events].toSorted((left, right) =>
    sequence(left.seq) < sequence(right.seq) ? -1 : 1
  )
  const oldestSequence = ordered[0]?.seq
  const newestSequence = ordered.at(-1)?.seq
  const bounded = oldestSequence !== undefined && sequence(requestedFrom) < sequence(oldestSequence)
  return {
    maxEvents: CHAT_EVENT_RETENTION_LIMIT,
    ...(oldestSequence !== undefined ? { oldestSequence } : {}),
    ...(newestSequence !== undefined ? { newestSequence } : {}),
    complete: !bounded && reason === undefined,
    ...(bounded ? { reason: 'retention' as const } : reason !== undefined ? { reason } : {}),
  }
}

export function createTranscriptAccumulator(input: {
  runtimeSessionId: string
  generation: number
  fromSequence?: string
}): TranscriptAccumulator {
  const fromSequence = input.fromSequence ?? '0'
  return {
    runtimeSessionId: input.runtimeSessionId,
    generation: input.generation,
    fromSequence,
    events: [],
    availability: { status: 'available' },
    retention: { maxEvents: CHAT_EVENT_RETENTION_LIMIT, complete: true },
  }
}

/**
 * Add a canonical event to a transcript. Events are deduped by the same key
 * as the host event log. A conflicting duplicate is surfaced and never
 * projected, and a sequence gap stops advancement until a fresh window is
 * attached.
 */
export function acceptRuntimeEvent(
  state: TranscriptAccumulator,
  event: RuntimeEvent
): TranscriptAccumulator {
  if (event.runtimeSessionId !== state.runtimeSessionId || event.generation !== state.generation)
    return state

  const existing = state.events.find((candidate) => eventKey(candidate) === eventKey(event))
  if (existing) {
    if (sameEvent(existing, event)) return state
    return {
      ...state,
      availability: { status: 'conflict', sourceEventId: event.sourceEventId },
    }
  }

  const sequenceCollision = state.events.find((candidate) => candidate.seq === event.seq)
  if (sequenceCollision) {
    return {
      ...state,
      availability: { status: 'conflict', sourceEventId: event.sourceEventId },
    }
  }

  const expected = state.expectedSequence
  const eventSequence = sequence(event.seq)
  // The host may drop the oldest portion of a bounded replay. The first
  // frame can therefore start after the requested sequence; subsequent jumps
  // remain genuine gaps and require a resync.
  const boundedReplayStart = state.events.length === 0 && expected !== undefined
  if (expected !== undefined && eventSequence > sequence(expected) && !boundedReplayStart) {
    return {
      ...state,
      availability: {
        status: 'resync_required',
        reason: 'sequence_gap',
        expectedSequence: expected,
        receivedSequence: event.seq,
      },
      retention: retention(state.events, state.fromSequence, 'sequence_gap'),
    }
  }

  const events = [...state.events, event].toSorted((left, right) =>
    sequence(left.seq) < sequence(right.seq) ? -1 : 1
  )
  const nextSequence = (eventSequence + 1n).toString()
  const bounded =
    events.length > CHAT_EVENT_RETENTION_LIMIT ? events.slice(-CHAT_EVENT_RETENTION_LIMIT) : events
  const window = retention(
    bounded,
    state.fromSequence,
    boundedReplayStart ? 'retention' : undefined
  )
  const boundedFromRetention = window.reason === 'retention'
  return {
    ...state,
    expectedSequence:
      expected === undefined || eventSequence >= sequence(expected) ? nextSequence : expected,
    events: bounded,
    availability: boundedFromRetention
      ? {
          status: 'bounded',
          reason: 'retention',
          oldestSequence: window.oldestSequence,
          requestedFromSequence: state.fromSequence,
        }
      : { status: 'available' },
    retention: window,
  }
}

/** Apply an authenticated runtime event stream frame to the projection. */
export function acceptRuntimeStreamFrame(
  state: TranscriptAccumulator,
  frame: DevStreamFrame,
  source: RuntimeEvent['source']
): TranscriptAccumulator {
  if (frame.type === 'opened') {
    if (frame.generation !== state.generation)
      return {
        ...state,
        availability: { status: 'stale_generation', generation: frame.generation },
      }
    const openedSequence = sequence(frame.nextSequence)
    const requested = sequence(state.fromSequence)
    return {
      ...state,
      expectedSequence: frame.nextSequence,
      availability:
        openedSequence > requested
          ? {
              status: 'bounded',
              reason: 'retention',
              oldestSequence: frame.nextSequence,
              requestedFromSequence: state.fromSequence,
            }
          : state.availability,
      retention: {
        ...state.retention,
        complete: openedSequence <= requested,
        ...(openedSequence > requested
          ? { oldestSequence: frame.nextSequence, reason: 'retention' as const }
          : {}),
      },
    }
  }
  if (frame.type === 'data') {
    try {
      const decoded = decodeCbor(frame.bytes)
      const event = decodeRuntimeEvent(decoded.value, { source })
      if (event.seq !== frame.sequence)
        return {
          ...state,
          availability: {
            status: 'resync_required',
            reason: 'sequence_gap',
            expectedSequence: state.expectedSequence ?? state.fromSequence,
            receivedSequence: frame.sequence,
          },
        }
      return acceptRuntimeEvent(state, event)
    } catch {
      return {
        ...state,
        availability: {
          status: 'resync_required',
          reason: 'sequence_gap',
          expectedSequence: state.expectedSequence ?? state.fromSequence,
          receivedSequence: frame.sequence,
        },
      }
    }
  }
  if (frame.type === 'resync') {
    return {
      ...state,
      availability: {
        status: 'bounded',
        reason: frame.reason,
        oldestSequence: frame.checkpointSequence,
      },
      retention: {
        ...state.retention,
        complete: false,
        reason: frame.reason,
        oldestSequence: frame.checkpointSequence,
      },
    }
  }
  if (frame.type === 'close' && frame.code === 'stale_generation')
    return { ...state, availability: { status: 'stale_generation', generation: state.generation } }
  return state
}

export function transcriptWindow(
  events: readonly RuntimeEvent[],
  options: { runtimeSessionId: string; generation: number; fromSequence?: string; limit?: number }
): TranscriptAccumulator {
  const initial = createTranscriptAccumulator(options)
  const limit = Math.min(Math.max(options.limit ?? 100, 1), CHAT_EVENT_RETENTION_LIMIT)
  const fromSequence = sequence(options.fromSequence ?? '0')
  let state = initial
  for (const item of [...events]
    .filter(
      (event) =>
        event.runtimeSessionId === options.runtimeSessionId &&
        event.generation === options.generation &&
        sequence(event.seq) >= fromSequence
    )
    .toSorted((left, right) => (sequence(left.seq) < sequence(right.seq) ? -1 : 1))
    .slice(0, limit)) {
    state = acceptRuntimeEvent(state, item)
  }
  return state
}
