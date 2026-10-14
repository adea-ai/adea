import { decodeCbor, decodeRuntimeEvent } from '@adea-ai/types/dev-runtime-wire'
import type { DevStreamFrame, RuntimeEvent, Scope } from '@adea-ai/types/dev-runtime'

import { buildDevCommand } from '../../browser/command'
import type { DevRuntimeService, DevStreamTransportSocket } from '../../platform'
import { ChatRuntimeError, eventSourceForStream, executeChatCommand } from './commands'
import {
  acceptRuntimeStreamFrame,
  createTranscriptAccumulator,
  type TranscriptAccumulator,
} from './transcript'

export function eventIdentity(event: RuntimeEvent): string {
  return `${event.generation}\u0000${event.source}\u0000${event.sourceEventId}`
}

export type RuntimeEventStream = Readonly<{
  state: () => TranscriptAccumulator
  /**
   * Registers a listener invoked on every accepted frame (and once on
   * close). Subscribing replaces polling: a surface that only re-reads
   * `state` on a timer wakes the UI thread forever while idle and still
   * renders up to one tick stale.
   */
  subscribe: (listener: (state: TranscriptAccumulator) => void) => () => void
  close: () => void
}>

export type OpenRuntimeEventStreamInput = Readonly<{
  service: DevRuntimeService
  scope: Scope
  runtimeSessionId: string
  resource: { kind: string; id: string; generation: number }
  generation: number
  fromSequence?: string
  source?: RuntimeEvent['source']
  /** Called with each event the accumulator accepted, in stream order. */
  onAccepted?: (event: RuntimeEvent) => void
}>

/**
 * Mint a read-direction `runtime-events-v1` grant for one session generation
 * and fold its frames into a bounded transcript accumulator. Chat and the
 * History pane read the canonical event log through this one path; neither
 * keeps a second store.
 */
export async function openRuntimeEventStream(
  input: OpenRuntimeEventStreamInput
): Promise<RuntimeEventStream> {
  const { service, scope, runtimeSessionId } = input
  const command = buildDevCommand({
    operation: 'dev.session.events',
    scope,
    body: {
      runtimeSessionId,
      expectedGeneration: input.generation,
      direction: 'read',
      ...(input.fromSequence !== undefined ? { fromSequence: input.fromSequence } : {}),
    },
    resource: input.resource,
  })
  const grant = await executeChatCommand<{
    resource: { generation: number }
    fromSequence: string
  }>(service, command)
  const transport = service.streams?.()
  if (!transport)
    throw new ChatRuntimeError({
      code: 'capability_unavailable',
      retryable: false,
      message: 'Runtime event stream is unavailable.',
    })
  let transcript = createTranscriptAccumulator({
    runtimeSessionId,
    generation: grant.resource.generation,
    fromSequence: grant.fromSequence,
  })
  let socket: DevStreamTransportSocket | undefined
  const pendingAcks: DevStreamFrame[] = []
  const listeners = new Set<(state: TranscriptAccumulator) => void>()
  const publish = () => {
    for (const listener of listeners) listener(transcript)
  }
  socket = transport.connect(grant as never, {
    onFrame: (frame) => {
      const source = eventSourceForStream({ source: input.source })
      let decodedEvent: RuntimeEvent | undefined
      if (frame.type === 'data') {
        try {
          const decoded = decodeCbor(frame.bytes)
          const candidate = decodeRuntimeEvent(decoded.value, { source })
          if (
            candidate.seq === frame.sequence &&
            candidate.runtimeSessionId === runtimeSessionId &&
            candidate.generation === input.generation
          )
            decodedEvent = candidate
        } catch {
          decodedEvent = undefined
        }
      }
      transcript = acceptRuntimeStreamFrame(transcript, frame, source)
      if (frame.type === 'data' && decodedEvent) {
        // The decoded identity is invariant across the window, so build it
        // once instead of once per retained event on every streamed frame.
        const decodedIdentity = eventIdentity(decodedEvent)
        const accepted = transcript.events.some((event) => eventIdentity(event) === decodedIdentity)
        if (accepted) input.onAccepted?.(decodedEvent)
        if (
          accepted &&
          transcript.availability.status !== 'resync_required' &&
          transcript.availability.status !== 'conflict' &&
          transcript.availability.status !== 'stale_generation'
        ) {
          const ack: DevStreamFrame = {
            type: 'ack',
            throughSequence: frame.sequence,
            availableCreditBytes: frame.bytes.byteLength,
          }
          if (socket?.open) socket.send(ack)
          else pendingAcks.push(ack)
        }
      }
      publish()
    },
    onClose: (_code, _reason) => publish(),
  })
  for (const ack of pendingAcks) if (socket.open) socket.send(ack)
  return {
    state: () => transcript,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      listeners.clear()
      socket.close(1000, 'chat detached')
    },
  }
}
