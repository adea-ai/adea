import { describe, expect, test } from 'bun:test'
import type { DevStreamFrame, RuntimeEvent } from '@adea-ai/types/dev-runtime'
import { encodeCbor } from '@adea-ai/types/dev-runtime'

import { openRuntimeEventStream } from '../src/chat/model/event-stream'
import {
  acceptRuntimeEvent,
  acceptRuntimeStreamFrame,
  createTranscriptAccumulator,
  markStreamClosed,
} from '../src/chat/model/transcript'
import type { DevRuntimeService } from '../src/platform'

const event = (seq: number): RuntimeEvent => ({
  schemaVersion: 1,
  eventId: `event-${seq}`,
  runtimeSessionId: 'session-a',
  generation: 1,
  seq: String(seq),
  occurredAt: '2026-10-18T00:00:00Z',
  receivedAt: '2026-10-18T00:00:00Z',
  source: 'host',
  sourceEventId: `source-${seq}`,
  confidence: 'authoritative',
  classification: 'workspace_metadata',
  kind: 'turn.user_input',
  payload: { text: `prompt ${seq}` },
})
const fresh = () =>
  acceptRuntimeEvent(
    createTranscriptAccumulator({
      runtimeSessionId: 'session-a',
      generation: 1,
      fromSequence: '4',
    }),
    event(4)
  )
const close = (code: Extract<DevStreamFrame, { type: 'close' }>['code'], reason?: string) =>
  ({ type: 'close', code, ...(reason !== undefined ? { reason } : {}) }) as const
const error = (code: string) =>
  ({ type: 'error', error: { code, message: 'the host said no', retryable: false } }) as never

const rejected = (frames: readonly DevStreamFrame[]) =>
  frames.reduce((state, frame) => acceptRuntimeStreamFrame(state, frame, 'host'), fresh())
    .streamClosed?.cursorRejected

function open() {
  const observers: {
    onFrame: (frame: DevStreamFrame) => void
    onClose: (c: number, r: string) => void
  }[] = []
  const service = {
    execute: async (command: { operation: string; requestId: string }) => ({
      ok: true,
      operation: command.operation,
      requestId: command.requestId,
      value: { resource: { generation: 1 }, fromSequence: '4' },
    }),
    streams: () => ({
      connect: (_grant: unknown, observer: (typeof observers)[number]) => {
        observers.push(observer)
        observer.onFrame({ type: 'data', sequence: '4', bytes: encodeCbor(event(4)) } as never)
        return { open: true, send: () => {}, close: () => {} }
      },
    }),
  } as unknown as DevRuntimeService
  return {
    observers,
    handle: openRuntimeEventStream({
      service,
      scope: { accountId: 'account-a', workspaceId: 'workspace-a', runtimeNodeId: 'node-a' },
      runtimeSessionId: 'session-a',
      generation: 1,
      resource: { kind: 'runtime_session', id: 'session-a', generation: 1 },
    }),
  }
}

describe('a stream that ends is not live', () => {
  test.each(['normal', 'expired', 'revoked', 'backpressure', 'incompatible'] as const)(
    'a %s close is recorded, not ignored',
    (code) => {
      const state = acceptRuntimeStreamFrame(fresh(), close(code, 'bye'), 'host')
      expect(state.streamClosed).toMatchObject({ code, reason: 'bye' })
      // The events already accepted stay; only the live link is gone.
      expect(state.events.map((entry) => entry.seq)).toEqual(['4'])
    }
  )

  test('only an incompatible close, or a close after a cursor error, says the cursor was refused', () => {
    expect(rejected([close('normal')])).toBe(false)
    expect(rejected([close('expired')])).toBe(false)
    expect(rejected([close('incompatible')])).toBe(true)
    expect(rejected([error('sequence_gap'), close('backpressure')])).toBe(true)
    expect(rejected([error('resync_required'), close('normal')])).toBe(true)
    expect(rejected([error('timeout'), close('normal')])).toBe(false)
  })

  test('a stale generation close still marks the generation stale and records the close', () => {
    const state = acceptRuntimeStreamFrame(fresh(), close('stale_generation'), 'host')
    expect(state.availability).toMatchObject({ status: 'stale_generation' })
    expect(state.streamClosed?.code).toBe('stale_generation')
  })

  test('the first close says why; a later one does not rewrite it', () => {
    const first = markStreamClosed(fresh(), 'incompatible', 'cursor refused')
    const second = markStreamClosed(first, 'transport')
    expect(second).toBe(first)
  })
})

describe('the production stream reports an ended stream', () => {
  test('a close frame reaches the subscriber', async () => {
    const { handle, observers } = open()
    const stream = await handle
    const seen: unknown[] = []
    stream.subscribe((state) => seen.push(state.streamClosed))
    observers[0]!.onFrame(close('incompatible', 'cursor is invalid'))
    expect(seen.at(-1)).toMatchObject({ code: 'incompatible', cursorRejected: true })
    expect(stream.state().streamClosed?.code).toBe('incompatible')
  })

  test('a socket that drops without a close frame is reported as ended', async () => {
    const { handle, observers } = open()
    const stream = await handle
    const seen: unknown[] = []
    stream.subscribe((state) => seen.push(state.streamClosed))
    observers[0]!.onClose(1006, 'abnormal')
    expect(seen.at(-1)).toMatchObject({
      code: 'transport',
      reason: 'abnormal',
      cursorRejected: false,
    })
  })
})
