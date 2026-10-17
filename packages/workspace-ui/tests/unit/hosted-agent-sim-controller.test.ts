import { describe, expect, test } from 'bun:test'
import { frameEnvelope, type SimFrameMessage } from '@adea-ai/spatial/sim-bridge'
import {
  createHostedSimController,
  type HostedSimControllerOptions,
  type HostedSimSnapshot,
} from '../../src/hosted-agent-sim-controller'

const SIM = 'https://sim.adea.example'
const NOW = Date.parse('2026-10-17T12:00:00.000Z')
const CODE = 'c'.repeat(43)

type Posted = { message: Record<string, unknown>; targetOrigin: string }

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(overrides: Partial<HostedSimControllerOptions> = {}) {
  let clock = NOW
  const posted: Posted[] = []
  const frameWindow = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message: message as Record<string, unknown>, targetOrigin })
    },
  }
  const requests: {
    request: Parameters<HostedSimControllerOptions['requestGrant']>[0]
    signal: AbortSignal
    resolve(v: unknown): void
    reject(e: unknown): void
  }[] = []
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  const snapshots: HostedSimSnapshot[] = []
  let ids = 0
  const controller = createHostedSimController({
    frameOrigin: SIM,
    workspaceId: 'ws_1',
    surface: 'hq',
    platform: 'web',
    requestGrant: (request, signal) =>
      new Promise((resolve, reject) => {
        requests.push({ request, signal, resolve, reject })
      }),
    frameWindow: () => frameWindow,
    onChange: (snapshot) => snapshots.push(snapshot),
    now: () => clock,
    mintBridgeId: () => `bridge-id-number-${String(++ids).padStart(4, '0')}`,
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    ...overrides,
  })
  const granted = (surface = 'hq') => ({
    status: 'granted',
    code: CODE,
    expiresAt: new Date(clock + 60_000).toISOString(),
    surface,
    frameOrigin: SIM,
  })
  const fromFrame = (message: SimFrameMessage, bridgeId?: string) => ({
    origin: SIM,
    source: frameWindow,
    data: frameEnvelope(bridgeId ?? controller.snapshot().frame!.bridgeId, message),
  })
  const phase = () => controller.snapshot().state.phase
  const live = () => timers.filter((timer) => !timer.cancelled)
  return {
    controller,
    posted,
    requests,
    timers,
    live,
    snapshots,
    frameWindow,
    granted,
    fromFrame,
    flush,
    phase,
    advance: (ms: number) => void (clock += ms),
  }
}

async function awaitingFrame() {
  const w = setup()
  w.controller.start()
  w.requests[0]!.resolve(w.granted())
  await w.flush()
  return w
}

const withVersion = (
  message: ReturnType<ReturnType<typeof setup>['fromFrame']>,
  version: number
) => ({
  ...message,
  data: { ...(message.data as object), version },
})

const stale = (w: ReturnType<typeof setup>) => ({
  ...w.granted(),
  expiresAt: new Date(NOW - 1000).toISOString(),
})

async function launched(w: ReturnType<typeof setup>) {
  w.controller.start()
  w.requests[0]!.resolve(w.granted())
  await w.flush()
  w.controller.handleMessage(w.fromFrame({ type: 'frame.ready', payload: {} }))
}

describe('hosted Agent Sim controller', () => {
  test.each([null, undefined, '', 'https://*.adea.example', 'http://sim.adea.example'])(
    'sim origin %p is not configured and nothing is requested',
    (frameOrigin) => {
      const w = setup({ frameOrigin })
      w.controller.start()
      const snapshot = w.controller.snapshot()
      expect(snapshot.state).toMatchObject({ phase: 'unavailable', reason: 'not_configured' })
      expect(snapshot.frame).toBeNull()
      expect(snapshot.notice?.title).toBe('Agent Sim is not set up here')
      expect(w.requests).toHaveLength(0)
    }
  )

  test('loopback http needs the explicit opt-in', () => {
    const closed = setup({ frameOrigin: 'http://localhost:4100' })
    closed.controller.start()
    expect(closed.requests).toHaveLength(0)
    const open = setup({ frameOrigin: 'http://localhost:4100', allowLoopbackHttp: true })
    open.controller.start()
    expect(open.requests).toHaveLength(1)
  })

  test('requests a launch with a fresh bridge id and shows no frame until a grant arrives', () => {
    const w = setup()
    w.controller.start()
    expect(w.requests).toHaveLength(1)
    expect(w.requests[0]!.request).toEqual({
      schemaVersion: 1,
      workspaceId: 'ws_1',
      surface: 'hq',
      platform: 'web',
      bridgeId: 'bridge-id-number-0001',
    })
    expect(w.controller.snapshot()).toMatchObject({ frame: null, starting: true })
  })

  test('a grant shows the frame, ready launches once, running and close finish the attempt', async () => {
    const w = setup({ character: 'ada' })
    w.controller.start()
    w.requests[0]!.resolve(w.granted())
    await w.flush()
    expect(w.controller.snapshot().frame).toEqual({
      origin: SIM,
      bridgeId: 'bridge-id-number-0001',
    })
    expect(w.phase()).toBe('awaiting_frame')
    expect(w.posted).toHaveLength(0)

    w.controller.handleMessage(w.fromFrame({ type: 'frame.ready', payload: {} }))
    expect(w.phase()).toBe('launching')
    expect(w.posted).toHaveLength(1)
    expect(w.posted[0]!.targetOrigin).toBe(SIM)
    expect(w.posted[0]!.message).toMatchObject({
      channel: 'adea.agent-sim.bridge',
      version: 1,
      bridgeId: 'bridge-id-number-0001',
      type: 'host.launch',
      payload: { code: CODE, surface: 'hq', character: 'ada' },
    })

    // A replayed ready never launches a second time.
    w.controller.handleMessage(w.fromFrame({ type: 'frame.ready', payload: {} }))
    expect(w.posted).toHaveLength(1)

    w.controller.handleMessage(w.fromFrame({ type: 'frame.state', payload: { state: 'running' } }))
    expect(w.phase()).toBe('running')
    expect(w.controller.snapshot()).toMatchObject({ starting: false, notice: null })
    expect(w.live()).toHaveLength(0)

    w.controller.handleMessage(w.fromFrame({ type: 'frame.close', payload: {} }))
    expect(w.phase()).toBe('idle')
    expect(w.controller.snapshot().frame).toBeNull()
  })

  test('messages from another origin, window or bridge id are dropped without failing the attempt', async () => {
    const w = setup()
    w.controller.start()
    w.requests[0]!.resolve(w.granted())
    await w.flush()
    const ready = w.fromFrame({ type: 'frame.ready', payload: {} })
    for (const event of [
      { ...ready, origin: 'https://evil.example' },
      { ...ready, origin: 'null' },
      { ...ready, source: { postMessage() {} } },
      { ...ready, source: null },
      w.fromFrame({ type: 'frame.ready', payload: {} }, 'a-different-bridge-id'),
      { ...ready, data: { ...(ready.data as object), extra: 'token' } },
      { ...ready, data: 'frame.ready' },
    ])
      w.controller.handleMessage(event)
    expect(w.phase()).toBe('awaiting_frame')
    expect(w.posted).toHaveLength(0)
    // The real frame still gets through afterwards.
    w.controller.handleMessage(ready)
    expect(w.phase()).toBe('launching')
  })

  test('a frame speaking another protocol version is bridge_incompatible', async () => {
    const w = setup()
    w.controller.start()
    w.requests[0]!.resolve(w.granted())
    await w.flush()
    const ready = w.fromFrame({ type: 'frame.ready', payload: {} })
    w.controller.handleMessage({ ...ready, data: { ...(ready.data as object), version: 2 } })
    expect(w.controller.snapshot().state).toMatchObject({
      phase: 'unavailable',
      reason: 'bridge_incompatible',
    })
    expect(w.controller.snapshot().frame).toBeNull()
  })

  test('a frame error is shown with its truthful reason', async () => {
    const w = setup()
    await launched(w)
    w.controller.handleMessage(
      w.fromFrame({ type: 'frame.error', payload: { code: 'engine_failed' } })
    )
    expect(w.controller.snapshot().state).toMatchObject({ reason: 'engine_failed' })
    expect(w.controller.snapshot().notice?.retryable).toBe(true)
  })

  test.each([
    [{ status: 'denied', reason: 'unauthenticated' }, 'unauthenticated'],
    [{ status: 'denied', reason: 'not_entitled' }, 'not_entitled'],
    [{ status: 'unavailable', reason: 'not_configured' }, 'not_configured'],
    [{ status: 'unavailable', reason: 'service_unavailable' }, 'service_unavailable'],
  ] as const)('a backend %j shows %s and no frame', async (reply, reason) => {
    const w = setup()
    w.controller.start()
    w.requests[0]!.resolve(reply)
    await w.flush()
    expect(w.controller.snapshot().state).toMatchObject({ phase: 'unavailable', reason })
    expect(w.controller.snapshot().frame).toBeNull()
  })

  test('a malformed, stale, wrong-surface or foreign-origin grant is refused', async () => {
    const replies: ((w: ReturnType<typeof setup>) => unknown)[] = [
      () => null,
      () => 'granted',
      (w) => ({ ...w.granted(), token: 't' }),
      (w) => w.granted('room-designer'),
      (w) => ({ ...w.granted(), frameOrigin: 'https://evil.example' }),
      stale,
      (w) => ({ ...w.granted(), expiresAt: new Date(NOW + 10 * 60_000).toISOString() }),
    ]
    for (const reply of replies) {
      const w = setup()
      w.controller.start()
      w.requests[0]!.resolve(reply(w))
      await w.flush()
      expect(w.controller.snapshot().state).toMatchObject({
        phase: 'unavailable',
        reason: 'service_unavailable',
      })
      expect(w.controller.snapshot().frame).toBeNull()
    }
  })

  test('a failed request is service_unavailable', async () => {
    const w = setup()
    w.controller.start()
    w.requests[0]!.reject(new Error('offline'))
    await w.flush()
    expect(w.controller.snapshot().state).toMatchObject({ reason: 'service_unavailable' })
  })

  test('a request that never answers times out and is aborted', async () => {
    const w = setup({ requestTimeoutMs: 5000 })
    w.controller.start()
    const timer = w.live()[0]!
    expect(timer.ms).toBe(5000)
    timer.run()
    await w.flush()
    expect(w.requests[0]!.signal.aborted).toBe(true)
    expect(w.controller.snapshot().state).toMatchObject({ reason: 'service_unavailable' })
    // A late answer to the abandoned request changes nothing.
    w.requests[0]!.resolve(w.granted())
    await w.flush()
    expect(w.phase()).toBe('unavailable')
  })

  test('timeouts are clamped to the supported range', () => {
    const fast = setup({ requestTimeoutMs: 1 })
    fast.controller.start()
    expect(fast.live()[0]!.ms).toBe(1000)
    const slow = setup({ requestTimeoutMs: 10 ** 9 })
    slow.controller.start()
    expect(slow.live()[0]!.ms).toBe(60_000)
  })

  test('a frame that never becomes ready times out', async () => {
    const w = setup({ frameTimeoutMs: 8000 })
    w.controller.start()
    w.requests[0]!.resolve(w.granted())
    await w.flush()
    const timer = w.live()[0]!
    expect(timer.ms).toBe(8000)
    timer.run()
    expect(w.controller.snapshot().state).toMatchObject({ reason: 'frame_timeout' })
    expect(w.controller.snapshot().frame).toBeNull()
  })

  test('a launched frame that never reports running times out', async () => {
    const w = setup()
    await launched(w)
    expect(w.phase()).toBe('launching')
    w.live()[0]!.run()
    expect(w.controller.snapshot().state).toMatchObject({ reason: 'frame_timeout' })
  })

  test('retry starts a new attempt with a new bridge id and ignores the old attempt', async () => {
    const w = setup()
    w.controller.start()
    w.requests[0]!.resolve(w.granted())
    await w.flush()
    const first = w.controller.snapshot().frame!
    w.live()[0]!.run()
    expect(w.phase()).toBe('unavailable')

    w.controller.start()
    expect(w.requests).toHaveLength(2)
    expect(w.requests[1]!.request.bridgeId).not.toBe(first.bridgeId)
    // A message from the first attempt's frame can no longer reach the new one.
    w.controller.handleMessage(w.fromFrame({ type: 'frame.ready', payload: {} }, first.bridgeId))
    expect(w.phase()).toBe('requesting')
    expect(w.posted).toHaveLength(0)

    w.requests[1]!.resolve(w.granted())
    await w.flush()
    expect(w.controller.snapshot().frame!.bridgeId).toBe(w.requests[1]!.request.bridgeId)
    w.controller.handleMessage(w.fromFrame({ type: 'frame.ready', payload: {} }))
    expect(w.posted).toHaveLength(1)
  })

  test('start does nothing while an attempt is in flight', () => {
    const w = setup()
    w.controller.start()
    w.controller.start()
    expect(w.requests).toHaveLength(1)
  })

  test('a ready from a frame whose window is gone is dropped, not accepted', async () => {
    const w = setup({ frameWindow: () => null })
    w.controller.start()
    w.requests[0]!.resolve(w.granted())
    await w.flush()
    w.controller.handleMessage({
      origin: SIM,
      source: w.frameWindow,
      data: frameEnvelope('bridge-id-number-0001', { type: 'frame.ready', payload: {} }),
    })
    expect(w.phase()).toBe('awaiting_frame')
  })

  test('a launch that cannot be delivered is launch_rejected', async () => {
    const broken = {
      postMessage() {
        throw new Error('detached')
      },
    }
    const w = setup({ frameWindow: () => broken })
    w.controller.start()
    w.requests[0]!.resolve(w.granted())
    await w.flush()
    w.controller.handleMessage({
      origin: SIM,
      source: broken,
      data: frameEnvelope('bridge-id-number-0001', { type: 'frame.ready', payload: {} }),
    })
    expect(w.controller.snapshot().state).toMatchObject({ reason: 'launch_rejected' })
    expect(w.controller.snapshot().frame).toBeNull()
  })

  test('offline is shown truthfully and retrying recovers', async () => {
    const w = setup()
    await launched(w)
    w.controller.setOffline()
    expect(w.phase()).toBe('offline')
    expect(w.controller.snapshot().frame).toBeNull()
    expect(w.controller.snapshot().notice?.detail).toContain('Chat and Dev are not affected')
    w.controller.start()
    expect(w.phase()).toBe('requesting')
  })

  test('dispose says goodbye to the frame, aborts the request and ignores everything after', async () => {
    const w = setup()
    await launched(w)
    w.controller.dispose()
    const goodbye = w.posted.at(-1)!
    expect(goodbye.message).toMatchObject({ type: 'host.dispose', payload: {} })
    expect(goodbye.targetOrigin).toBe(SIM)
    expect(w.live()).toHaveLength(0)
    const before = w.snapshots.length
    w.controller.handleMessage(
      w.fromFrame({ type: 'frame.ready', payload: {} }, 'bridge-id-number-0001')
    )
    w.controller.start()
    expect(w.snapshots).toHaveLength(before)
    expect(w.requests).toHaveLength(1)
  })

  test('dispose during the request aborts it and a late grant is ignored', async () => {
    const w = setup()
    w.controller.start()
    w.controller.dispose()
    expect(w.requests[0]!.signal.aborted).toBe(true)
    w.requests[0]!.resolve(w.granted())
    await w.flush()
    expect(w.phase()).toBe('idle')
    expect(w.controller.snapshot().frame).toBeNull()
  })

  describe('protocol version and channel nonce', () => {
    test('an unsupported version with the wrong nonce is ignored and the attempt survives', async () => {
      const w = await awaitingFrame()
      const wrong = w.fromFrame({ type: 'frame.ready', payload: {} }, 'bridge-id-number-9999')
      w.controller.handleMessage(withVersion(wrong, 2))
      expect(w.phase()).toBe('awaiting_frame')
      expect(w.controller.snapshot().frame).not.toBeNull()
      // The current frame still launches afterwards.
      w.controller.handleMessage(w.fromFrame({ type: 'frame.ready', payload: {} }))
      expect(w.phase()).toBe('launching')
    })

    test('an unsupported version with the current nonce still fails the attempt', async () => {
      const w = await awaitingFrame()
      w.controller.handleMessage(withVersion(w.fromFrame({ type: 'frame.ready', payload: {} }), 2))
      expect(w.controller.snapshot().state).toMatchObject({
        phase: 'unavailable',
        reason: 'bridge_incompatible',
      })
    })

    test('a previous attempt’s nonce at an unsupported version cannot fail the new attempt', async () => {
      const w = await awaitingFrame()
      const oldId = w.controller.snapshot().frame!.bridgeId
      w.controller.setOffline()
      w.controller.start()
      w.requests[1]!.resolve(w.granted())
      await w.flush()
      expect(w.controller.snapshot().frame!.bridgeId).not.toBe(oldId)
      w.controller.handleMessage(
        withVersion(w.fromFrame({ type: 'frame.ready', payload: {} }, oldId), 2)
      )
      expect(w.phase()).toBe('awaiting_frame')
    })

    test.each([
      ['another channel', { channel: 'someone.else' }],
      ['no channel', { channel: undefined }],
      ['a non-string nonce', { bridgeId: 7 }],
    ])('an unsupported version with %s is ignored', async (_label, patch) => {
      const w = await awaitingFrame()
      const ready = withVersion(w.fromFrame({ type: 'frame.ready', payload: {} }), 2)
      w.controller.handleMessage({ ...ready, data: { ...(ready.data as object), ...patch } })
      expect(w.phase()).toBe('awaiting_frame')
    })

    test('an accessor for the nonce is never run and the message is ignored', async () => {
      const w = await awaitingFrame()
      let ran = false
      const ready = w.fromFrame({ type: 'frame.ready', payload: {} })
      const data = { ...(ready.data as object), version: 2 }
      Object.defineProperty(data, 'bridgeId', {
        enumerable: true,
        get() {
          ran = true
          return w.controller.snapshot().frame!.bridgeId
        },
      })
      w.controller.handleMessage({ ...ready, data })
      expect(ran).toBe(false)
      expect(w.phase()).toBe('awaiting_frame')
    })

    test('an unsupported version from the wrong window or origin is still dropped', async () => {
      const w = await awaitingFrame()
      const ready = withVersion(w.fromFrame({ type: 'frame.ready', payload: {} }), 2)
      w.controller.handleMessage({ ...ready, origin: 'https://evil.example' })
      w.controller.handleMessage({ ...ready, source: {} })
      expect(w.phase()).toBe('awaiting_frame')
    })
  })

  describe('starting offline', () => {
    test('starts in the offline state with no grant request and a retry', () => {
      let online = false
      const w = setup({ isOnline: () => online })
      w.controller.start()
      expect(w.phase()).toBe('offline')
      expect(w.requests).toHaveLength(0)
      expect(w.live()).toHaveLength(0)
      expect(w.controller.snapshot().notice).toMatchObject({
        title: 'Agent Sim is offline',
        retryable: true,
      })
      expect(w.controller.snapshot().frame).toBeNull()

      // Retrying while still offline asks nothing.
      w.controller.start()
      expect(w.phase()).toBe('offline')
      expect(w.requests).toHaveLength(0)

      online = true
      w.controller.start()
      expect(w.phase()).toBe('requesting')
      expect(w.requests).toHaveLength(1)
    })

    test('coming back online starts the launch without a retry', () => {
      let online = false
      const w = setup({ isOnline: () => online })
      w.controller.start()
      w.controller.setOnline()
      expect(w.phase()).toBe('offline')
      expect(w.requests).toHaveLength(0)
      online = true
      w.controller.setOnline()
      expect(w.phase()).toBe('requesting')
      expect(w.requests).toHaveLength(1)
    })

    test('coming back online does nothing unless the surface is offline', async () => {
      const w = setup()
      w.controller.setOnline()
      expect(w.phase()).toBe('idle')
      w.controller.start()
      w.controller.setOnline()
      expect(w.requests).toHaveLength(1)
      w.requests[0]!.resolve(w.granted())
      await w.flush()
      w.controller.setOnline()
      expect(w.requests).toHaveLength(1)
      expect(w.phase()).toBe('awaiting_frame')
    })

    test('going offline mid-attempt and back online relaunches with a new nonce', async () => {
      const w = setup()
      w.controller.start()
      w.requests[0]!.resolve(w.granted())
      await w.flush()
      const first = w.controller.snapshot().frame!.bridgeId
      w.controller.setOffline()
      expect(w.phase()).toBe('offline')
      w.controller.setOnline()
      expect(w.phase()).toBe('requesting')
      w.requests[1]!.resolve(w.granted())
      await w.flush()
      expect(w.controller.snapshot().frame!.bridgeId).not.toBe(first)
    })

    test('an unreadable online probe counts as online', () => {
      const w = setup({
        isOnline: () => {
          throw new Error('no navigator')
        },
      })
      w.controller.start()
      expect(w.phase()).toBe('requesting')
    })
  })
})
