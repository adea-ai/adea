// Issue #396 client transport: exactly-once ordered delivery, duplicate and
// gap guards, bounded input queue with backpressure, reconnect backoff,
// heartbeat timeout, suspend/resume, and explicit resync (never a silent
// counter advance). Mechanics adapted from bb's transport with the
// authenticated grant path in place of its URL.
import { describe, expect, test } from 'bun:test'

import type { DevStreamFrame } from '@adea-ai/types/dev-runtime'
import {
  createTerminalTransport,
  DEFAULT_TRANSPORT_LIMITS,
  type TerminalAttachContext,
  type TerminalStreamSocket,
} from '../src/terminal/transport'

type FakeServer = {
  context: TerminalAttachContext
  frames: DevStreamFrame[]
  closed: Array<{ code: number; reason: string }>
  deliver: (frame: DevStreamFrame) => void
  close: (code: number, reason: string) => void
  bufferedAmount: number
}

type HarnessOptions = {
  generations?: number[]
  sequences?: string[]
  bufferedAmounts?: number[]
  synchronousFrames?: DevStreamFrame[][]
  synchronousSendFrames?: Array<{
    attempt: number
    type: DevStreamFrame['type']
    frame: DevStreamFrame
  }>
  connectFailures?: unknown[]
  heartbeatMode?: 'bidirectional' | 'server_only'
  sendFailures?: Array<{
    attempt: number
    type: DevStreamFrame['type']
    afterDelivery?: boolean
  }>
}

function makeHarness(
  limitOverrides: Partial<typeof DEFAULT_TRANSPORT_LIMITS> = {},
  harnessOptions: HarnessOptions = {}
) {
  let server: FakeServer | null = null
  let connectAttempt = 0
  const sockets: FakeServer[] = []
  const contexts: TerminalAttachContext[] = []
  const output: Array<{ sequence: string; text: string }> = []
  const states: string[] = []
  const gaps: Array<{ expected: string; received: string }> = []
  const resyncs: string[] = []
  const overflows: number[] = []
  const errors: Array<{ code: string; retryable: boolean; message: string }> = []

  function connect(
    handlers: {
      onFrame: (frame: DevStreamFrame) => void
      onClose: () => void
    },
    context: TerminalAttachContext
  ): TerminalStreamSocket {
    const attempt = connectAttempt++
    contexts.push(context)
    const connectFailure = harnessOptions.connectFailures?.[attempt]
    if (connectFailure !== undefined) throw connectFailure
    const generation = harnessOptions.generations?.[attempt] ?? 1
    const fake: FakeServer = {
      context,
      frames: [],
      closed: [],
      bufferedAmount: harnessOptions.bufferedAmounts?.[attempt] ?? 0,
      deliver: (frame) => queueMicrotask(() => handlers.onFrame(frame)),
      close: (code, reason) => {
        fake.closed.push({ code, reason })
        queueMicrotask(() => handlers.onClose())
      },
    }
    server = fake
    sockets.push(fake)
    const socket: TerminalStreamSocket = {
      get bufferedAmount() {
        return fake.bufferedAmount
      },
      get open() {
        return true
      },
      send: (frame) => {
        const synchronousFrame = harnessOptions.synchronousSendFrames?.find(
          (candidate) => candidate.attempt === attempt && candidate.type === frame.type
        )
        if (synchronousFrame) handlers.onFrame(synchronousFrame.frame)
        const sendFailure = harnessOptions.sendFailures?.find(
          (candidate) => candidate.attempt === attempt && candidate.type === frame.type
        )
        if (sendFailure?.afterDelivery) fake.frames.push(frame)
        if (sendFailure) throw new Error('fake socket send failed')
        fake.frames.push(frame)
      },
      close: (code, reason) => fake.close(code, reason),
    }
    const immediate = harnessOptions.synchronousFrames?.[attempt]
    const opened: DevStreamFrame = {
      type: 'opened',
      protocol: 'terminal-bytes-v1',
      generation,
      nextSequence: harnessOptions.sequences?.[attempt] ?? context.fromSequence,
    }
    if (immediate) {
      for (const frame of immediate) handlers.onFrame(frame)
    } else {
      queueMicrotask(() => handlers.onFrame(opened))
    }
    return socket
  }

  const transport = createTerminalTransport({
    connect,
    heartbeatMode: harnessOptions.heartbeatMode,
    onOutput: (sequence, bytes) => output.push({ sequence, text: new TextDecoder().decode(bytes) }),
    onConnectionState: (state) => states.push(state),
    onConnectionError: (error) => errors.push(error),
    onSequenceGap: (expected, received) => gaps.push({ expected, received }),
    onResyncRequired: (anchor) => resyncs.push(anchor),
    onInputOverflow: (max) => overflows.push(max),
    limits: {
      reconnectBaseMs: 4,
      reconnectMaxMs: 8,
      heartbeatIntervalMs: 20,
      heartbeatUnhealthyAfterMs: 60,
      ...limitOverrides,
    },
  })

  return {
    transport,
    get server() {
      return server
    },
    sockets,
    contexts,
    output,
    states,
    gaps,
    resyncs,
    overflows,
    errors,
  }
}

function data(sequence: string, text: string): DevStreamFrame {
  return { type: 'data', sequence, bytes: new TextEncoder().encode(text) }
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await Bun.sleep(1)
  }
}

describe('terminal transport', () => {
  test('uses the first authenticated open generation for queued input and resize', async () => {
    const harness = makeHarness()
    harness.transport.start('7')
    expect(harness.contexts).toEqual([{ fromSequence: '7' }])
    expect(harness.transport.write(new TextEncoder().encode('queued'))).toBe(true)
    harness.transport.resize(100, 30)
    expect(harness.server!.frames).toEqual([])

    await Bun.sleep(5)

    expect(harness.server!.frames).toContainEqual({
      type: 'input',
      sequence: '0',
      generation: 1,
      bytes: new TextEncoder().encode('queued'),
    })
    expect(harness.server!.frames).toContainEqual({
      type: 'resize',
      sequence: '0',
      generation: 1,
      cols: 100,
      rows: 30,
    })
    harness.transport.dispose()
  })

  test('reconnect supplies the accepted cursor and last verified generation', async () => {
    const harness = makeHarness()
    harness.transport.start('10')
    await Bun.sleep(5)
    harness.server!.deliver(data('10', 'accepted'))
    await Bun.sleep(5)
    harness.server!.close(1006, 'network flap')
    await Bun.sleep(40)

    expect(harness.contexts[0]).toEqual({ fromSequence: '10' })
    expect(harness.contexts[1]).toEqual({ fromSequence: '11', generation: 1 })
    harness.transport.dispose()
  })

  test('synchronous replay is acknowledged after connect returns its socket', () => {
    const harness = makeHarness(
      {},
      {
        synchronousFrames: [
          [
            {
              type: 'opened',
              protocol: 'terminal-bytes-v1',
              generation: 4,
              nextSequence: '0',
            },
            data('0', 'synchronous replay'),
          ],
        ],
      }
    )
    harness.transport.start('0')

    expect(harness.output.map((entry) => entry.text)).toEqual(['synchronous replay'])
    expect(harness.sockets[0]!.frames).toContainEqual({
      type: 'ack',
      throughSequence: '0',
      availableCreditBytes: new TextEncoder().encode('synchronous replay').byteLength,
    })
    harness.transport.dispose()
  })

  test('stale socket frames and closes cannot affect the replacement connection', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    await Bun.sleep(5)
    const stale = harness.sockets[0]!
    stale.close(1006, 'network flap')
    await Bun.sleep(40)
    expect(harness.sockets).toHaveLength(2)

    stale.deliver(data('0', 'must be ignored'))
    stale.close(1006, 'late old close')
    await Bun.sleep(10)

    expect(harness.output).toEqual([])
    expect(harness.transport.snapshot().nextOutputSeq).toBe('0')
    expect(harness.transport.snapshot().state).toBe('open')
    expect(harness.sockets).toHaveLength(2)
    harness.transport.dispose()
  })

  test('a new authenticated generation resets the output cursor before accepting data', async () => {
    const harness = makeHarness({}, { generations: [3, 4], sequences: ['0', '0'] })
    harness.transport.start('0')
    await waitFor(() => harness.transport.snapshot().state === 'open', 'initial stream open')
    harness.sockets[0]!.deliver(data('0', 'generation three'))
    await waitFor(() => harness.output.length === 1, 'first generation output')
    harness.sockets[0]!.close(1006, 'network flap')
    await waitFor(
      () => harness.contexts.length === 2 && harness.transport.snapshot().state === 'open',
      'reconnected stream open'
    )

    expect(harness.contexts[1]).toEqual({ fromSequence: '1', generation: 3 })
    expect(harness.transport.snapshot().state).toBe('open')
    expect(harness.transport.snapshot().nextOutputSeq).toBe('0')
    harness.sockets[1]!.deliver(data('0', 'generation four'))
    await waitFor(() => harness.output.length === 2, 'new generation output')
    expect(harness.output.map((entry) => entry.text)).toEqual([
      'generation three',
      'generation four',
    ])
    expect(harness.transport.snapshot().nextOutputSeq).toBe('1')
    expect(harness.transport.write(new Uint8Array([1]))).toBe(true)
    expect(harness.sockets[1]!.frames).toContainEqual({
      type: 'input',
      sequence: '0',
      generation: 4,
      bytes: new Uint8Array([1]),
    })
    harness.transport.dispose()
  })

  test('a changed generation drops queued old-generation input but keeps the fresh stream usable', async () => {
    const full = 2 * 1024 * 1024
    const harness = makeHarness({}, { generations: [3, 4], sequences: ['0', '0'] })
    harness.transport.start('0')
    await Bun.sleep(5)
    harness.sockets[0]!.bufferedAmount = full
    expect(harness.transport.write(new TextEncoder().encode('belongs to generation three'))).toBe(
      true
    )
    harness.sockets[0]!.close(1006, 'network flap')
    await Bun.sleep(40)

    expect(harness.transport.snapshot()).toMatchObject({ state: 'open', pendingInputBytes: 0 })
    expect(harness.errors).toContainEqual(
      expect.objectContaining({ code: 'stale_generation', retryable: false })
    )
    expect(harness.sockets[1]!.frames.filter((frame) => frame.type === 'input')).toHaveLength(0)

    harness.sockets[1]!.deliver(data('0', 'new generation output'))
    await Bun.sleep(5)
    expect(harness.output.map((entry) => entry.text)).toEqual(['new generation output'])
    expect(harness.transport.write(new TextEncoder().encode('new input'))).toBe(true)
    expect(harness.sockets[1]!.frames).toContainEqual({
      type: 'input',
      sequence: '0',
      generation: 4,
      bytes: new TextEncoder().encode('new input'),
    })
    harness.transport.dispose()
  })

  test('an opened cursor mismatch cannot authorize the stream', () => {
    const harness = makeHarness(
      {},
      {
        synchronousFrames: [
          [
            {
              type: 'opened',
              protocol: 'terminal-bytes-v1',
              generation: 1,
              nextSequence: '1',
            },
          ],
        ],
      }
    )
    harness.transport.start('0')

    expect(harness.transport.snapshot().state).toBe('closed')
    expect(harness.transport.write(new Uint8Array([1]))).toBe(false)
    expect(harness.sockets[0]!.frames.filter((frame) => frame.type === 'input')).toHaveLength(0)
    expect(harness.errors[0]).toMatchObject({ code: 'sequence_gap', retryable: false })
    harness.transport.dispose()
  })

  test('an incompatible protocol or malformed generation cannot authorize writes', () => {
    const openedFrames: Array<{ frame: DevStreamFrame; code: string }> = [
      {
        frame: {
          type: 'opened',
          protocol: 'browser-frames-v1',
          generation: 1,
          nextSequence: '0',
        },
        code: 'unsupported_version',
      },
      {
        frame: {
          type: 'opened',
          protocol: 'terminal-bytes-v1',
          generation: -1,
          nextSequence: '0',
        },
        code: 'stale_generation',
      },
    ]
    for (const candidate of openedFrames) {
      const harness = makeHarness({}, { synchronousFrames: [[candidate.frame]] })
      harness.transport.start('0')

      expect(harness.transport.snapshot().state).toBe('closed')
      expect(harness.transport.write(new Uint8Array([1]))).toBe(false)
      expect(harness.sockets[0]!.frames.filter((frame) => frame.type === 'input')).toHaveLength(0)
      expect(harness.errors[0]).toMatchObject({ code: candidate.code, retryable: false })
      harness.transport.dispose()
    }
  })

  test('nonretryable permission and generation errors stop reconnecting', async () => {
    for (const code of ['permission_denied', 'stale_generation'] as const) {
      const harness = makeHarness()
      harness.transport.start('0')
      await Bun.sleep(5)
      harness.server!.deliver({
        type: 'error',
        error: { code, retryable: false, message: 'attach refused' },
      })
      await Bun.sleep(25)

      expect(harness.errors).toContainEqual({ code, retryable: false, message: 'attach refused' })
      expect(harness.transport.snapshot().state).toBe('closed')
      expect(harness.sockets).toHaveLength(1)
      harness.transport.dispose()
    }
  })

  test('synchronous typed connect failures stop or retry without leaving a stuck attach', async () => {
    const denied = makeHarness(
      {},
      {
        connectFailures: [
          { code: 'permission_denied', retryable: false, message: 'attach refused' },
        ],
      }
    )
    denied.transport.start('0')
    expect(denied.transport.snapshot().state).toBe('closed')
    expect(denied.errors).toContainEqual({
      code: 'permission_denied',
      retryable: false,
      message: 'attach refused',
    })
    await Bun.sleep(20)
    expect(denied.contexts).toHaveLength(1)
    denied.transport.dispose()

    const temporary = makeHarness(
      {},
      {
        connectFailures: [
          { code: 'timeout', retryable: true, message: 'temporary attach failure' },
        ],
      }
    )
    temporary.transport.start('0')
    await Bun.sleep(25)
    expect(temporary.contexts).toHaveLength(2)
    expect(temporary.transport.snapshot().state).toBe('open')
    expect(temporary.errors).toContainEqual({
      code: 'timeout',
      retryable: true,
      message: 'temporary attach failure',
    })
    temporary.transport.dispose()

    const malformed = makeHarness(
      {},
      { connectFailures: [new Error('do not expose adapter details')] }
    )
    malformed.transport.start('0')
    expect(malformed.transport.snapshot().state).toBe('closed')
    expect(malformed.errors).toEqual([
      {
        code: 'runtime_node_unavailable',
        retryable: false,
        message: 'terminal stream connection could not be opened',
      },
    ])
    malformed.transport.dispose()
  })

  test('failed control sends best-effort close their socket before reconnecting', async () => {
    for (const frameType of ['ack', 'resize', 'heartbeat'] as const) {
      const harness = makeHarness(
        { heartbeatIntervalMs: 5, heartbeatUnhealthyAfterMs: 10_000 },
        { sendFailures: [{ attempt: 0, type: frameType }] }
      )
      if (frameType === 'resize') harness.transport.resize(100, 30)
      harness.transport.start('0')
      await Bun.sleep(5)
      if (frameType === 'ack') {
        harness.server!.deliver(data('0', 'ack trigger'))
        await Bun.sleep(5)
      }
      if (frameType === 'heartbeat') await Bun.sleep(10)

      expect(harness.sockets[0]!.closed).toContainEqual({
        code: 4001,
        reason: `${frameType} send failed`,
      })
      await Bun.sleep(25)
      expect(harness.sockets.length).toBeGreaterThanOrEqual(2)
      harness.transport.dispose()
    }
  })

  test('server-only heartbeat mode listens and enforces timeout without sending a client heartbeat', async () => {
    const harness = makeHarness(
      { heartbeatIntervalMs: 10, heartbeatUnhealthyAfterMs: 50 },
      { heartbeatMode: 'server_only' }
    )
    harness.transport.start('0')
    await Bun.sleep(18)

    expect(harness.server!.frames.filter((frame) => frame.type === 'heartbeat')).toHaveLength(0)
    harness.server!.deliver({
      type: 'heartbeat',
      observedAt: new Date().toISOString(),
      throughSequence: '0',
    })
    await Bun.sleep(25)
    expect(harness.contexts).toHaveLength(1)

    // Listening continues in server-only mode: when the host stops sending
    // heartbeats, the client still times out and requests a fresh grant.
    await Bun.sleep(55)
    expect(harness.contexts.length).toBeGreaterThanOrEqual(2)
    expect(harness.sockets.flatMap((socket) => socket.frames)).not.toContainEqual(
      expect.objectContaining({ type: 'heartbeat' })
    )
    harness.transport.dispose()
  })

  test('retryable stream errors reconnect with the same cursor and generation', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    await Bun.sleep(5)
    harness.server!.deliver(data('0', 'kept'))
    await Bun.sleep(5)
    harness.server!.deliver({
      type: 'error',
      error: { code: 'timeout', retryable: true, message: 'temporary failure' },
    })
    await Bun.sleep(40)

    expect(harness.contexts[1]).toEqual({ fromSequence: '1', generation: 1 })
    expect(harness.transport.snapshot().state).toBe('open')
    harness.transport.dispose()
  })

  test('delivers replay and live output exactly once in order', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    harness.server!.deliver(data('0', 'one '))
    harness.server!.deliver(data('1', 'two'))
    await waitFor(() => harness.output.length === 2, 'replayed output')
    expect(harness.output.map((entry) => entry.text)).toEqual(['one ', 'two'])
    // A duplicate replay is dropped, never rendered twice.
    harness.server!.deliver(data('1', 'two'))
    harness.server!.deliver(data('2', ' three'))
    await waitFor(() => harness.output.length === 3, 'live output')
    expect(harness.output.map((entry) => entry.text)).toEqual(['one ', 'two', ' three'])
    // Every data chunk acknowledges credit back to the server.
    const acks = harness.server!.frames.filter((frame) => frame.type === 'ack')
    expect(acks).toHaveLength(3)
    harness.transport.dispose()
  })

  test('a sequence gap surfaces a resync request instead of advancing silently', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    await Bun.sleep(5)
    harness.server!.deliver(data('3', 'skipped'))
    await Bun.sleep(10)
    expect(harness.gaps).toEqual([{ expected: '0', received: '3' }])
    expect(harness.output).toEqual([])
    // The client re-anchors from the checkpoint and continues cleanly.
    harness.transport.resyncFrom('3')
    await Bun.sleep(10)
    expect(harness.transport.snapshot().nextOutputSeq).toBe('3')
    harness.server!.deliver(data('3', 'after resync'))
    await Bun.sleep(10)
    expect(harness.output.map((entry) => entry.text)).toEqual(['after resync'])
    harness.transport.dispose()
  })

  test('a server resync frame carries the checkpoint anchor', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    await Bun.sleep(5)
    harness.server!.deliver({ type: 'resync', reason: 'backpressure', checkpointSequence: '17' })
    await Bun.sleep(10)
    expect(harness.resyncs).toEqual(['17'])
    harness.transport.dispose()
  })

  test('input beyond the queue bound is backpressure and never sent', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    await Bun.sleep(5)
    const big = new Uint8Array(2 * 1024 * 1024)
    expect(harness.transport.write(big)).toBe(false)
    expect(harness.overflows).toEqual([1024 * 1024])
    expect(harness.server!.frames.filter((frame) => frame.type === 'input')).toHaveLength(0)
    harness.transport.dispose()
  })

  test('queued input drains through the high-water window', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    await Bun.sleep(5)
    // First write rides the open socket; the second is queued.
    expect(harness.transport.write(new TextEncoder().encode('a'))).toBe(true)
    harness.server!.bufferedAmount = 2 * 1024 * 1024
    expect(harness.transport.write(new TextEncoder().encode('b'))).toBe(true)
    expect(harness.server!.frames.filter((frame) => frame.type === 'input')).toHaveLength(1)
    harness.server!.bufferedAmount = 0
    await Bun.sleep(10)
    expect(harness.server!.frames.filter((frame) => frame.type === 'input').length).toBe(2)
    harness.transport.dispose()
  })

  test('queued input is snapshotted before the caller can mutate its byte buffer', async () => {
    const full = 2 * 1024 * 1024
    const harness = makeHarness({ heartbeatUnhealthyAfterMs: 60_000 }, { bufferedAmounts: [full] })
    harness.transport.start('0')
    await Bun.sleep(5)
    const bytes = new TextEncoder().encode('original input')
    expect(harness.transport.write(bytes)).toBe(true)
    bytes.fill(0x78)

    harness.server!.bufferedAmount = 0
    harness.server!.deliver(data('0', 'wake the queued input'))
    await Bun.sleep(5)

    expect(harness.server!.frames.filter((frame) => frame.type === 'input')).toContainEqual({
      type: 'input',
      sequence: '0',
      generation: 1,
      bytes: new TextEncoder().encode('original input'),
    })
    harness.transport.dispose()
  })

  test('synchronous terminal error during send does not underflow discarded input accounting', async () => {
    const full = 2 * 1024 * 1024
    const harness = makeHarness(
      { heartbeatUnhealthyAfterMs: 60_000 },
      {
        bufferedAmounts: [full],
        synchronousSendFrames: [
          {
            attempt: 0,
            type: 'input',
            frame: {
              type: 'error',
              error: {
                code: 'stale_generation',
                retryable: false,
                message: 'terminal generation changed',
              },
            },
          },
        ],
      }
    )
    harness.transport.start('0')
    await Bun.sleep(5)
    expect(harness.transport.write(new TextEncoder().encode('first'))).toBe(true)
    expect(harness.transport.write(new TextEncoder().encode('second'))).toBe(true)

    harness.server!.bufferedAmount = 0
    harness.server!.deliver(data('0', 'flush queued input'))
    await Bun.sleep(5)

    expect(harness.errors).toContainEqual(expect.objectContaining({ code: 'stale_generation' }))
    expect(harness.server!.frames.filter((frame) => frame.type === 'input')).toHaveLength(1)
    expect(harness.transport.snapshot()).toMatchObject({ state: 'closed', pendingInputBytes: 0 })
    harness.transport.dispose()
  })

  test('an ambiguous input send failure is reported, closed, and never replayed', async () => {
    for (const queued of [false, true]) {
      const harness = makeHarness(
        { heartbeatUnhealthyAfterMs: 60_000 },
        { sendFailures: [{ attempt: 0, type: 'input', afterDelivery: true }] }
      )
      harness.transport.start('0')
      await Bun.sleep(5)
      const bytes = new TextEncoder().encode('possibly delivered')
      if (queued) {
        harness.sockets[0]!.bufferedAmount = 2 * 1024 * 1024
        expect(harness.transport.write(bytes)).toBe(true)
        harness.sockets[0]!.bufferedAmount = 0
        await Bun.sleep(25)
      } else {
        expect(harness.transport.write(bytes)).toBe(false)
      }

      expect(harness.errors).toContainEqual(
        expect.objectContaining({ code: 'delivery_ambiguous', retryable: false })
      )
      expect(harness.transport.snapshot()).toMatchObject({ state: 'closed', pendingInputBytes: 0 })
      expect(harness.sockets[0]!.frames.filter((frame) => frame.type === 'input')).toHaveLength(1)
      expect(harness.sockets[0]!.closed).toContainEqual(
        expect.objectContaining({ code: 1000, reason: 'delivery_ambiguous' })
      )
      await Bun.sleep(25)
      expect(harness.sockets).toHaveLength(1)
      harness.transport.dispose()
    }
  })

  test('queued input keeps polling after reconnect when the new socket is backpressured', async () => {
    const full = 2 * 1024 * 1024
    const harness = makeHarness(
      { heartbeatUnhealthyAfterMs: 60_000 },
      { bufferedAmounts: [0, full] }
    )
    harness.transport.start('0')
    await Bun.sleep(5)
    harness.server!.bufferedAmount = full
    expect(harness.transport.write(new TextEncoder().encode('after-reconnect'))).toBe(true)
    harness.sockets[0]!.close(1006, 'network flap')
    await Bun.sleep(40)
    expect(harness.sockets).toHaveLength(2)
    expect(harness.sockets[1]!.frames.filter((frame) => frame.type === 'input')).toHaveLength(0)

    harness.sockets[1]!.bufferedAmount = 0
    // The bounded drain poll backs off to 100ms while the new socket is full.
    await Bun.sleep(120)
    expect(harness.sockets[1]!.frames).toContainEqual({
      type: 'input',
      sequence: '0',
      generation: 1,
      bytes: new TextEncoder().encode('after-reconnect'),
    })
    harness.transport.dispose()
  })

  // The drain poll used to run at a flat 100Hz for as long as any input was
  // queued, which is ~50 wake-ups per keystroke burst against a full window
  // while nothing was draining. Two properties are pinned here: a `data` frame
  // (which returns credit) wakes the drain immediately, and a poll that makes
  // no progress backs off instead of retrying at the fast rate forever.
  test('a credit frame wakes queued input immediately and a stalled drain backs off', async () => {
    // A generous heartbeat budget so the observation window below cannot be cut
    // short by the harness's own 60ms timeout (which would silently hand the
    // test a brand-new fake socket with no frames).
    const harness = makeHarness({ heartbeatUnhealthyAfterMs: 60_000 })
    harness.transport.start('0')
    await Bun.sleep(5)
    harness.transport.write(new TextEncoder().encode('a'))
    // Socket is full, so this one queues.
    harness.server!.bufferedAmount = 2 * 1024 * 1024
    expect(harness.transport.write(new TextEncoder().encode('b'))).toBe(true)
    expect(harness.server!.frames.filter((frame) => frame.type === 'input')).toHaveLength(1)

    // While the buffer stays full the poll retries with a growing interval
    // rather than at a flat 10ms, and still sends nothing.
    await Bun.sleep(120)
    expect(harness.server!.frames.filter((frame) => frame.type === 'input')).toHaveLength(1)

    // A credit-returning data frame frees the window, and the queued byte goes
    // out on that frame's turn — no waiting for the fallback poll.
    harness.server!.bufferedAmount = 0
    harness.server!.deliver({ type: 'data', sequence: '0', bytes: new Uint8Array([7]) })
    // `deliver` hops a microtask, so let the frame land.
    await Bun.sleep(5)
    expect(harness.server!.frames.filter((frame) => frame.type === 'input')).toHaveLength(2)
    harness.transport.dispose()
  })

  test('connection loss schedules bounded exponential reconnects and resumes the stream', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    await Bun.sleep(5)
    expect(harness.states).toContain('open')
    harness.server!.close(1006, 'network flap')
    await Bun.sleep(5)
    expect(harness.states).toContain('reconnecting')
    await Bun.sleep(40)
    // A fresh authenticated stream (new grant) replaced the dead socket.
    expect(harness.sockets.length).toBeGreaterThanOrEqual(2)
    expect(
      harness.transport.snapshot().state === 'open' ||
        harness.transport.snapshot().state === 'connecting'
    ).toBe(true)
    harness.transport.dispose()
  })

  test('a terminal-exit close code stops reconnection', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    await Bun.sleep(5)
    harness.server!.deliver({ type: 'close', code: 'normal' })
    await Bun.sleep(30)
    expect(harness.transport.snapshot().state).toBe('closed')
    expect(harness.sockets).toHaveLength(1)
  })

  test('suspend stops timers and resume reconnects without re-anchoring', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    await Bun.sleep(5)
    harness.transport.suspend()
    expect(harness.transport.snapshot().state).toBe('closed')
    const socketsBefore = harness.sockets.length
    harness.transport.resume()
    await Bun.sleep(20)
    expect(harness.sockets.length).toBeGreaterThan(socketsBefore)
    // The cursor survived the suspend/resume cycle.
    harness.server!.deliver(data('0', 'still ordered'))
    await Bun.sleep(10)
    expect(harness.output.map((entry) => entry.text)).toEqual(['still ordered'])
    harness.transport.dispose()
  })
})

test('a resize after attach is delivered immediately on the authenticated generation', async () => {
  const harness = makeHarness({ heartbeatIntervalMs: 60_000 })
  try {
    harness.transport.start('0')
    await Bun.sleep(5)
    harness.transport.resize(112, 35)
    expect(harness.server!.frames).toContainEqual({
      type: 'resize',
      sequence: '0',
      generation: 1,
      cols: 112,
      rows: 35,
    })
    harness.transport.resize(112, 35)
    expect(harness.server!.frames.filter((frame) => frame.type === 'resize')).toHaveLength(1)
  } finally {
    harness.transport.dispose()
  }
})
