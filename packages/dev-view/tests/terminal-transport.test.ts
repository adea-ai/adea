// Issue #396 client transport: exactly-once ordered delivery, duplicate and
// gap guards, bounded input queue with backpressure, reconnect backoff,
// heartbeat timeout, suspend/resume, and explicit resync (never a silent
// counter advance). Mechanics adapted from bb's transport with the
// authenticated grant path in place of its URL.
import { describe, expect, test } from 'bun:test'

import type { DevStreamFrame } from '@adea-ai/types/dev-runtime'
import { createTerminalTransport, type TerminalStreamSocket } from '../src/terminal/transport'

type FakeServer = {
  frames: DevStreamFrame[]
  closed: Array<{ code: number; reason: string }>
  deliver: (frame: DevStreamFrame) => void
  close: (code: number, reason: string) => void
  bufferedAmount: number
}

function makeHarness() {
  let server: FakeServer | null = null
  const sockets: FakeServer[] = []
  const output: Array<{ sequence: string; text: string }> = []
  const states: string[] = []
  const gaps: Array<{ expected: string; received: string }> = []
  const resyncs: string[] = []
  const overflows: number[] = []

  function connect(): TerminalStreamSocket {
    const fake: FakeServer = {
      frames: [],
      closed: [],
      bufferedAmount: 0,
      deliver: (frame) => {
        queueMicrotask(() => handlers.onFrame(frame))
      },
      close: (code, reason) => {
        fake.closed.push({ code, reason })
        queueMicrotask(() => handlers.onClose())
      },
    }
    server = fake
    sockets.push(fake)
    const handlers = {
      onFrame: (frame: DevStreamFrame) => void frame,
      onClose: () => {},
    }
    // Wire the handlers lazily through the transport's connect callback.
    queueMicrotask(() => undefined)
    fake.deliver = (frame) => {
      queueMicrotask(() => currentHandlers?.onFrame(frame))
    }
    fake.close = (code, reason) => {
      fake.closed.push({ code, reason })
      queueMicrotask(() => currentHandlers?.onClose())
    }
    let currentHandlers: { onFrame: (frame: DevStreamFrame) => void; onClose: () => void } | null =
      null
    pendingHandlers = (handlers2) => {
      currentHandlers = handlers2
    }
    return {
      get bufferedAmount() {
        return fake.bufferedAmount
      },
      get open() {
        return true
      },
      send: (frame) => {
        fake.frames.push(frame)
      },
      close: (code, reason) => fake.close(code, reason),
    }
  }

  let pendingHandlers:
    | ((handlers: { onFrame: (frame: DevStreamFrame) => void; onClose: () => void }) => void)
    | null = null

  const transport = createTerminalTransport({
    connect: (handlers) => {
      const socket = connect()
      pendingHandlers?.(handlers)
      return socket
    },
    onOutput: (sequence, bytes) => output.push({ sequence, text: new TextDecoder().decode(bytes) }),
    onConnectionState: (state) => states.push(state),
    onSequenceGap: (expected, received) => gaps.push({ expected, received }),
    onResyncRequired: (anchor) => resyncs.push(anchor),
    onInputOverflow: (max) => overflows.push(max),
    limits: {
      reconnectBaseMs: 4,
      reconnectMaxMs: 8,
      heartbeatIntervalMs: 20,
      heartbeatUnhealthyAfterMs: 60,
    },
  })

  return {
    transport,
    get server() {
      return server
    },
    sockets,
    output,
    states,
    gaps,
    resyncs,
    overflows,
  }
}

function data(sequence: string, text: string): DevStreamFrame {
  return { type: 'data', sequence, bytes: new TextEncoder().encode(text) }
}

describe('terminal transport', () => {
  test('delivers replay and live output exactly once in order', async () => {
    const harness = makeHarness()
    harness.transport.start('0')
    await Bun.sleep(5)
    harness.server!.deliver(data('0', 'one '))
    harness.server!.deliver(data('1', 'two'))
    await Bun.sleep(10)
    expect(harness.output.map((entry) => entry.text)).toEqual(['one ', 'two'])
    // A duplicate replay is dropped, never rendered twice.
    harness.server!.deliver(data('1', 'two'))
    harness.server!.deliver(data('2', ' three'))
    await Bun.sleep(10)
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
