import { describe, expect, test } from 'bun:test'
import {
  MAX_SIM_LAUNCH_TTL_MS,
  MAX_SIM_MESSAGE_BYTES,
  SIM_BRIDGE_CHANNEL,
  SIM_IDLE,
  SIM_SESSION_COOKIE_NAME,
  SIM_UNAVAILABLE_REASONS,
  buildSimSessionClearCookie,
  buildSimSessionSetCookie,
  canonicalBridgeOrigin,
  createBridgeId,
  createLaunchCodeLedger,
  createLaunchOnce,
  createOriginAllowlist,
  describeSimAvailability,
  frameEnvelope,
  hostEnvelope,
  parseFrameMessage,
  parseHostMessage,
  parseSimLaunchGrant,
  parseSimLaunchRequest,
  parseSimSessionExchangeRequest,
  parseSimSessionExchangeResult,
  postToFrame,
  postToHost,
  readSimSessionCookie,
  reduceSimLaunch,
  simSessionCookieViolations,
  type SimFrameMessage,
  type SimHostMessage,
  type SimLaunchState,
} from '../src/sim-bridge'

const SIM = 'https://sim.adea.example'
const HOST = 'https://app.adea.example'
const BRIDGE = 'AbCdEfGhIjKlMnOpQrSt'
const CODE = 'c'.repeat(43)
const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()
const origins = createOriginAllowlist([SIM])

const frameWindow = { id: 'frame' }
const parentWindow = { id: 'parent' }
const hostContext = { origins, frameWindow, bridgeId: BRIDGE }
const frameContext = { parentOrigin: HOST, parentWindow, bridgeId: BRIDGE }

function fromFrame(message: unknown, overrides: Partial<{ origin: string; source: unknown }> = {}) {
  return { origin: SIM, source: frameWindow, data: message, ...overrides }
}

function envelope(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    channel: SIM_BRIDGE_CHANNEL,
    version: 1,
    bridgeId: BRIDGE,
    type,
    payload,
    ...extra,
  }
}

describe('origin allowlist', () => {
  test('accepts only exact canonical origins', () => {
    expect(canonicalBridgeOrigin(SIM)).toBe(SIM)
    for (const bad of [
      `${SIM}/`,
      `${SIM}/path`,
      `${SIM}?x=1`,
      'https://user@sim.adea.example',
      'https://*.adea.example',
      '*',
      'null',
      '',
      'sim.adea.example',
      'javascript:alert(1)',
      'file:///tmp/x',
      42,
      null,
    ])
      expect(canonicalBridgeOrigin(bad)).toBeNull()
  })

  test('matches by exact string only', () => {
    expect(origins.has(SIM)).toBe(true)
    for (const other of [
      'https://sim.adea.example:444',
      'https://evil.sim.adea.example',
      'https://sim.adea.example.evil.test',
      'http://sim.adea.example',
      'null',
      undefined,
    ])
      expect(origins.has(other)).toBe(false)
  })

  test('loopback http needs an explicit opt-in and stays loopback', () => {
    expect(canonicalBridgeOrigin('http://localhost:5173')).toBeNull()
    expect(canonicalBridgeOrigin('http://localhost:5173', { allowLoopbackHttp: true })).toBe(
      'http://localhost:5173'
    )
    expect(canonicalBridgeOrigin('http://127.0.0.1:1', { allowLoopbackHttp: true })).not.toBeNull()
    expect(canonicalBridgeOrigin('http://sim.adea.example', { allowLoopbackHttp: true })).toBeNull()
    expect(() => createOriginAllowlist(['http://localhost:5173'])).toThrow()
  })

  test('refuses an empty or invalid list instead of allowing everything', () => {
    expect(() => createOriginAllowlist([])).toThrow()
    expect(() => createOriginAllowlist([SIM, '*'])).toThrow()
  })
})

describe('frame to host messages', () => {
  const valid: [SimFrameMessage, unknown][] = [
    [{ type: 'frame.ready', payload: {} }, envelope('frame.ready', {})],
    [{ type: 'frame.close', payload: {} }, envelope('frame.close', {})],
    [
      { type: 'frame.state', payload: { state: 'running' } },
      envelope('frame.state', { state: 'running' }),
    ],
    [
      { type: 'frame.state', payload: { state: 'unavailable', reason: 'engine_failed' } },
      envelope('frame.state', { state: 'unavailable', reason: 'engine_failed' }),
    ],
    [
      { type: 'frame.error', payload: { code: 'asset_unavailable' } },
      envelope('frame.error', { code: 'asset_unavailable' }),
    ],
  ]

  test.each(valid)('accepts %o', (message, data) => {
    expect(parseFrameMessage(fromFrame(data), hostContext)).toEqual({ ok: true, message })
  })

  test('refuses an unlisted or opaque origin before looking at the data', () => {
    for (const origin of ['https://evil.example', 'null', HOST, `${SIM}/`])
      expect(
        parseFrameMessage(fromFrame(envelope('frame.ready', {}), { origin }), hostContext)
      ).toEqual({
        ok: false,
        reason: 'origin_refused',
      })
  })

  test('refuses another window even at the allowlisted origin', () => {
    for (const source of [{ id: 'other' }, null, undefined, window0()])
      expect(
        parseFrameMessage(fromFrame(envelope('frame.ready', {}), { source }), hostContext)
      ).toEqual({
        ok: false,
        reason: 'source_mismatch',
      })
  })

  test('refuses a missing frame window rather than matching null to null', () => {
    expect(
      parseFrameMessage(fromFrame(envelope('frame.ready', {}), { source: null }), {
        ...hostContext,
        frameWindow: null,
      })
    ).toEqual({ ok: false, reason: 'source_mismatch' })
  })

  test('refuses foreign, wrong-version and wrong-bridge envelopes', () => {
    const cases: [unknown, string][] = [
      ['frame.ready', 'not_a_bridge_message'],
      [null, 'not_a_bridge_message'],
      [envelope('frame.ready', {}, { channel: 'other' }), 'not_a_bridge_message'],
      [envelope('frame.ready', {}, { version: 2 }), 'version_unsupported'],
      [envelope('frame.ready', {}, { bridgeId: 'ZyXwVuTsRqPoNmLkJiHg' }), 'bridge_mismatch'],
      [{ ...envelope('frame.ready', {}), extra: 1 }, 'not_a_bridge_message'],
    ]
    for (const [data, reason] of cases)
      expect(parseFrameMessage(fromFrame(data), hostContext)).toEqual({
        ok: false,
        reason: reason as never,
      })
  })

  test('has no generic call, native or credential message', () => {
    for (const type of [
      'frame.call',
      'frame.rpc',
      'frame.eval',
      'frame.fs.read',
      'frame.token',
      'frame.navigate',
      'host.launch',
      '',
    ])
      expect(parseFrameMessage(fromFrame(envelope(type, {})), hostContext)).toEqual({
        ok: false,
        reason: 'unknown_type',
      })
  })

  test('validates payloads strictly', () => {
    const bad: [string, unknown][] = [
      ['frame.ready', { extra: 1 }],
      ['frame.ready', null],
      ['frame.ready', []],
      ['frame.state', {}],
      ['frame.state', { state: 'exploded' }],
      ['frame.state', { state: 'running', reason: 'engine_failed' }],
      ['frame.state', { state: 'running', token: 'abc' }],
      ['frame.state', { state: 'unavailable' }],
      ['frame.state', { state: 'unavailable', reason: 'because' }],
      ['frame.error', { code: 'engine_failed', stack: 'at x' }],
      ['frame.error', { code: 'nope' }],
    ]
    for (const [type, payload] of bad)
      expect(parseFrameMessage(fromFrame(envelope(type, payload)), hostContext)).toEqual({
        ok: false,
        reason: 'invalid_payload',
      })
  })

  test('refuses oversized, accessor, symbol and non-plain data', () => {
    expect(
      parseFrameMessage(
        fromFrame(
          envelope('frame.state', { state: 'running', pad: 'x'.repeat(MAX_SIM_MESSAGE_BYTES) })
        ),
        hostContext
      )
    ).toEqual({ ok: false, reason: 'too_large' })

    let ran = false
    const accessor = Object.defineProperty({}, 'state', {
      enumerable: true,
      get() {
        ran = true
        return 'running'
      },
    })
    expect(parseFrameMessage(fromFrame(envelope('frame.state', accessor)), hostContext).ok).toBe(
      false
    )
    expect(ran).toBe(false)

    const symbolic = { state: 'running', [Symbol('x')]: 1 }
    expect(parseFrameMessage(fromFrame(envelope('frame.state', symbolic)), hostContext).ok).toBe(
      false
    )

    class Payload {
      state = 'running'
    }
    expect(
      parseFrameMessage(fromFrame(envelope('frame.state', new Payload())), hostContext).ok
    ).toBe(false)
    expect(
      parseFrameMessage(fromFrame(envelope('frame.state', { state: 'running' }, {})), {
        ...hostContext,
        bridgeId: 'short',
      })
    ).toEqual({ ok: false, reason: 'bridge_mismatch' })
  })

  test('terminates on cyclic payloads, including under an empty-string key', () => {
    const selfRef: Record<string, unknown> = {}
    selfRef[''] = selfRef
    expect(parseFrameMessage(fromFrame(envelope('frame.ready', selfRef)), hostContext)).toEqual({
      ok: false,
      reason: 'too_large',
    })
    const pair: Record<string, unknown> = {}
    pair.a = { b: pair }
    expect(parseFrameMessage(fromFrame(envelope('frame.state', pair)), hostContext).ok).toBe(false)
    // A cycle through the envelope itself.
    const looped: Record<string, unknown> = envelope('frame.ready', {})
    looped.payload = looped
    expect(parseFrameMessage(fromFrame(looped), hostContext).ok).toBe(false)
  })

  test('refuses wide and deep payloads without walking them', () => {
    const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, 1]))
    expect(parseFrameMessage(fromFrame(envelope('frame.ready', wide)), hostContext)).toEqual({
      ok: false,
      reason: 'too_large',
    })
    let deep: Record<string, unknown> = {}
    for (let i = 0; i < 10_000; i++) deep = { n: deep }
    expect(parseFrameMessage(fromFrame(envelope('frame.ready', deep)), hostContext)).toEqual({
      ok: false,
      reason: 'too_large',
    })
    // An empty payload nested a few levels is still just an invalid payload, not a hang.
    expect(
      parseFrameMessage(
        fromFrame(envelope('frame.ready', { a: { b: { c: { d: {} } } } })),
        hostContext
      ).ok
    ).toBe(false)
    expect(
      parseFrameMessage(fromFrame({ ...envelope('frame.ready', {}), wide }), hostContext)
    ).toEqual({ ok: false, reason: 'not_a_bridge_message' })
  })

  test('survives prototype pollution keys', () => {
    const polluted = JSON.parse('{"state":"running","__proto__":{"reason":"engine_failed"}}')
    expect(parseFrameMessage(fromFrame(envelope('frame.state', polluted)), hostContext).ok).toBe(
      false
    )
  })
})

const fromHost = (data: unknown, overrides: Partial<{ origin: string; source: unknown }> = {}) => ({
  origin: HOST,
  source: parentWindow,
  data,
  ...overrides,
})

const run = (state: SimLaunchState, ...events: Parameters<typeof reduceSimLaunch>[1][]) =>
  events.reduce((current, event) => reduceSimLaunch(current.state, event), {
    state,
  } as ReturnType<typeof reduceSimLaunch>)

/** Host and frame wired through an in-memory event channel with exact origin and window identity. */
function wire() {
  const hostWindow = { id: 'host' }
  const simWindow = { id: 'sim' }
  const hostInbox: unknown[] = []
  const frameInbox: unknown[] = []
  return {
    hostWindow,
    simWindow,
    hostInbox,
    frameInbox,
    toHost: {
      postMessage: (data: unknown, target: string) =>
        hostInbox.push({ origin: SIM, source: simWindow, data, target }),
    },
    toFrame: {
      postMessage: (data: unknown, target: string) =>
        frameInbox.push({ origin: HOST, source: hostWindow, data, target }),
    },
  }
}

function window0() {
  return {}
}

describe('host to frame messages', () => {
  const launch = {
    code: CODE,
    expiresAt: iso(60_000),
    surface: 'hq',
  } as const

  test('accepts a launch and a dispose from the exact parent', () => {
    expect(
      parseHostMessage(
        fromHost(envelope('host.launch', { ...launch, character: 'ada_01' })),
        frameContext
      )
    ).toEqual({
      ok: true,
      message: { type: 'host.launch', payload: { ...launch, character: 'ada_01' } },
    })
    expect(parseHostMessage(fromHost(envelope('host.dispose', {})), frameContext)).toEqual({
      ok: true,
      message: { type: 'host.dispose', payload: {} },
    })
  })

  test('refuses other origins and windows', () => {
    const data = envelope('host.dispose', {})
    expect(
      parseHostMessage(fromHost(data, { origin: 'https://evil.example' }), frameContext)
    ).toEqual({
      ok: false,
      reason: 'origin_refused',
    })
    expect(parseHostMessage(fromHost(data, { source: {} }), frameContext)).toEqual({
      ok: false,
      reason: 'source_mismatch',
    })
  })

  test('rejects malformed launch payloads and anything credential-shaped', () => {
    const bad = [
      { ...launch, code: 'short' },
      { ...launch, code: `${CODE}!` },
      { ...launch, expiresAt: 'tomorrow' },
      { ...launch, surface: 'admin' },
      { ...launch, character: '' },
      { ...launch, character: 'a b' },
      { ...launch, token: 'secret' },
      { ...launch, sessionToken: 'secret' },
      { code: CODE, surface: 'hq' },
    ]
    for (const payload of bad)
      expect(parseHostMessage(fromHost(envelope('host.launch', payload)), frameContext)).toEqual({
        ok: false,
        reason: 'invalid_payload',
      })
  })

  test('has no message other than launch and dispose', () => {
    for (const type of ['host.call', 'host.rpc', 'host.token', 'host.fs', 'frame.ready'])
      expect(parseHostMessage(fromHost(envelope(type, {})), frameContext)).toEqual({
        ok: false,
        reason: 'unknown_type',
      })
  })
})

describe('posting', () => {
  test('host posts only to an allowlisted origin, never to *', () => {
    const calls: unknown[][] = []
    const target = { postMessage: (...args: unknown[]) => calls.push(args) }
    const message: SimHostMessage = { type: 'host.dispose', payload: {} }
    postToFrame(target, SIM, origins, BRIDGE, message)
    expect(calls).toEqual([[hostEnvelope(BRIDGE, message), SIM]])
    expect(() => postToFrame(target, '*', origins, BRIDGE, message)).toThrow()
    expect(() => postToFrame(target, 'https://evil.example', origins, BRIDGE, message)).toThrow()
    expect(() => postToFrame(target, SIM, origins, 'bad', message)).toThrow()
    expect(calls).toHaveLength(1)
  })

  test('frame posts only to its exact host origin', () => {
    const calls: unknown[][] = []
    const target = { postMessage: (...args: unknown[]) => calls.push(args) }
    const message: SimFrameMessage = { type: 'frame.ready', payload: {} }
    postToHost(target, HOST, BRIDGE, message)
    expect(calls).toEqual([[frameEnvelope(BRIDGE, message), HOST]])
    for (const bad of ['*', 'null', 'app.adea.example'])
      expect(() => postToHost(target, bad, BRIDGE, message)).toThrow()
  })

  test('bridge ids are fresh, url-safe and long enough', () => {
    const first = createBridgeId()
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(createBridgeId()).not.toBe(first)
  })
})

describe('launch contract', () => {
  const expectation = { origins, now: NOW, surface: 'hq' as const }
  const granted = {
    status: 'granted',
    code: CODE,
    expiresAt: iso(60_000),
    surface: 'hq',
    frameOrigin: SIM,
  } as const

  test('parses a strict launch request', () => {
    const request = {
      schemaVersion: 1,
      workspaceId: 'ws_123',
      surface: 'hq',
      platform: 'desktop',
      bridgeId: BRIDGE,
    } as const
    expect(parseSimLaunchRequest(request)).toEqual(request)
    for (const bad of [
      { ...request, schemaVersion: 2 },
      { ...request, platform: 'tv' },
      { ...request, surface: 'x' },
      { ...request, workspaceId: '' },
      { ...request, token: 'secret' },
      { ...request, accountToken: 'secret' },
      { ...request, bridgeId: 'short' },
      null,
    ])
      expect(parseSimLaunchRequest(bad)).toBeNull()
  })

  test('accepts a fresh grant for the asked surface and an allowlisted frame', () => {
    expect(parseSimLaunchGrant(granted, expectation)).toEqual(granted)
  })

  test('refuses stale, over-long, wrong-surface and wrong-origin grants', () => {
    const bad = [
      { ...granted, expiresAt: iso(0) },
      { ...granted, expiresAt: iso(-1000) },
      { ...granted, expiresAt: iso(MAX_SIM_LAUNCH_TTL_MS + 1) },
      { ...granted, surface: 'room-designer' },
      { ...granted, frameOrigin: 'https://evil.example' },
      { ...granted, frameOrigin: '*' },
      { ...granted, code: 'short' },
      { ...granted, sessionToken: 'secret' },
      { ...granted, accessToken: 'secret' },
      { status: 'granted' },
      { status: 'maybe' },
      null,
      'granted',
    ]
    for (const value of bad) expect(parseSimLaunchGrant(value, expectation)).toBeNull()
    expect(
      parseSimLaunchGrant({ ...granted, expiresAt: iso(MAX_SIM_LAUNCH_TTL_MS) }, expectation)
    ).not.toBeNull()
  })

  test('never runs a getter, including the status discriminant', () => {
    let ran = 0
    const throwing = () =>
      Object.defineProperty({}, 'status', {
        enumerable: true,
        get() {
          ran++
          throw new Error('getter ran')
        },
      })
    expect(parseSimLaunchGrant(throwing(), expectation)).toBeNull()
    expect(parseSimSessionExchangeResult(throwing())).toBeNull()
    expect(parseSimLaunchRequest(throwing())).toBeNull()
    expect(parseSimSessionExchangeRequest(throwing())).toBeNull()

    // A getter on a later field of an otherwise valid shape is refused too.
    const grantWithGetter = Object.defineProperty({ ...granted }, 'code', {
      enumerable: true,
      get() {
        ran++
        return CODE
      },
    })
    expect(parseSimLaunchGrant(grantWithGetter, expectation)).toBeNull()
    const sessionWithGetter = Object.defineProperty({ status: 'session' }, 'expiresAt', {
      enumerable: true,
      get() {
        ran++
        return iso(1000)
      },
    })
    expect(parseSimSessionExchangeResult(sessionWithGetter)).toBeNull()

    // A status inherited from the prototype is not an own data property.
    const inherited = Object.create({ status: 'unavailable' })
    expect(parseSimSessionExchangeResult(inherited)).toBeNull()
    expect(ran).toBe(0)
  })

  test('refuses wide records before reading them', () => {
    const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, 1]))
    expect(
      parseSimLaunchGrant({ status: 'denied', reason: 'not_entitled', ...wide }, expectation)
    ).toBeNull()
    expect(parseSimSessionExchangeResult({ status: 'unavailable', ...wide })).toBeNull()
  })

  test('carries refusals as closed reasons', () => {
    expect(parseSimLaunchGrant({ status: 'denied', reason: 'not_entitled' }, expectation)).toEqual({
      status: 'denied',
      reason: 'not_entitled',
    })
    expect(
      parseSimLaunchGrant({ status: 'unavailable', reason: 'not_configured' }, expectation)
    ).toEqual({
      status: 'unavailable',
      reason: 'not_configured',
    })
    expect(parseSimLaunchGrant({ status: 'denied', reason: 'banned' }, expectation)).toBeNull()
    expect(
      parseSimLaunchGrant({ status: 'denied', reason: 'not_entitled', detail: 'x' }, expectation)
    ).toBeNull()
  })

  test('exchange request and result are strict and never carry a token', () => {
    expect(
      parseSimSessionExchangeRequest({ schemaVersion: 1, code: CODE, bridgeId: BRIDGE })
    ).not.toBeNull()
    expect(
      parseSimSessionExchangeRequest({ schemaVersion: 1, code: CODE, bridgeId: BRIDGE, token: 'x' })
    ).toBeNull()
    expect(parseSimSessionExchangeResult({ status: 'session', expiresAt: iso(1000) })).toEqual({
      status: 'session',
      expiresAt: iso(1000),
    })
    expect(
      parseSimSessionExchangeResult({ status: 'session', expiresAt: iso(1000), token: 'x' })
    ).toBeNull()
    expect(
      parseSimSessionExchangeResult({ status: 'session', sessionId: 'x', expiresAt: iso(1000) })
    ).toBeNull()
    expect(parseSimSessionExchangeResult({ status: 'rejected', reason: 'code_used' })).toEqual({
      status: 'rejected',
      reason: 'code_used',
    })
    expect(parseSimSessionExchangeResult({ status: 'rejected', reason: 'whatever' })).toBeNull()
    expect(parseSimSessionExchangeResult({ status: 'unavailable' })).toEqual({
      status: 'unavailable',
    })
  })

  test('the frame honours a launch once, inside its window', () => {
    const payload = { code: CODE, expiresAt: iso(1000), surface: 'hq' as const }
    const once = createLaunchOnce()
    expect(once.take(payload, NOW)).toEqual(payload)
    expect(once.take(payload, NOW)).toBeNull()
    expect(createLaunchOnce().take(payload, NOW + 1000)).toBeNull()
    expect(createLaunchOnce().take({ ...payload, expiresAt: 'x' }, NOW)).toBeNull()
  })

  test('the reference ledger spends a code on first presentation', () => {
    const ledger = createLaunchCodeLedger()
    const binding = { bridgeId: BRIDGE, origin: SIM, surface: 'hq' as const }
    ledger.issue(CODE, binding, NOW + 1000)
    expect(ledger.redeem(CODE, { bridgeId: BRIDGE, origin: SIM }, NOW)).toEqual({
      ok: true,
      surface: 'hq',
    })
    expect(ledger.redeem(CODE, { bridgeId: BRIDGE, origin: SIM }, NOW)).toEqual({
      ok: false,
      reason: 'code_used',
    })
    expect(ledger.redeem('x'.repeat(43), { bridgeId: BRIDGE, origin: SIM }, NOW)).toEqual({
      ok: false,
      reason: 'unknown',
    })

    ledger.issue('d'.repeat(43), binding, NOW + 1000)
    expect(
      ledger.redeem('d'.repeat(43), { bridgeId: BRIDGE, origin: 'https://evil.example' }, NOW)
    ).toEqual({
      ok: false,
      reason: 'origin_refused',
    })
    expect(ledger.redeem('d'.repeat(43), { bridgeId: BRIDGE, origin: SIM }, NOW)).toEqual({
      ok: false,
      reason: 'code_used',
    })

    ledger.issue('e'.repeat(43), binding, NOW)
    expect(ledger.redeem('e'.repeat(43), { bridgeId: BRIDGE, origin: SIM }, NOW)).toEqual({
      ok: false,
      reason: 'code_expired',
    })
    ledger.issue('f'.repeat(43), binding, NOW + 1000)
    expect(
      ledger.redeem('f'.repeat(43), { bridgeId: 'ZyXwVuTsRqPoNmLkJiHg', origin: SIM }, NOW)
    ).toEqual({
      ok: false,
      reason: 'origin_refused',
    })
  })
})

describe('launch state machine', () => {
  const granted = parseSimLaunchGrant(
    { status: 'granted', code: CODE, expiresAt: iso(60_000), surface: 'hq', frameOrigin: SIM },
    { origins, now: NOW, surface: 'hq' }
  )
  if (granted?.status !== 'granted') throw new Error('fixture')

  const frame = (attempt: number, message: SimFrameMessage, now = NOW) => ({
    type: 'frame' as const,
    attempt,
    message,
    now,
  })
  const ready = (attempt: number, now = NOW) =>
    frame(attempt, { type: 'frame.ready', payload: {} }, now)
  const grant = (attempt: number) => ({ type: 'grant' as const, attempt, grant: granted })

  test('walks idle to running only through confirmed steps', () => {
    let step = reduceSimLaunch(SIM_IDLE, { type: 'start' })
    expect(step).toEqual({
      state: { phase: 'requesting', attempt: 1 },
      effect: { type: 'request_grant', attempt: 1 },
    })
    step = reduceSimLaunch(step.state, grant(1))
    expect(step.state).toEqual({ phase: 'awaiting_frame', attempt: 1, grant: granted })
    expect(step.effect).toBeUndefined()
    step = reduceSimLaunch(step.state, ready(1))
    expect(step).toEqual({
      state: { phase: 'launching', attempt: 1 },
      effect: { type: 'post_launch', attempt: 1, grant: granted },
    })
    step = reduceSimLaunch(
      step.state,
      frame(1, { type: 'frame.state', payload: { state: 'loading' } })
    )
    expect(step.state.phase).toBe('launching')
    step = reduceSimLaunch(
      step.state,
      frame(1, { type: 'frame.state', payload: { state: 'running' } })
    )
    expect(step.state).toEqual({ phase: 'running', attempt: 1 })
  })

  test('a replayed ready never posts a second launch', () => {
    const launching = run(SIM_IDLE, { type: 'start' }, grant(1), ready(1))
    expect(launching.effect?.type).toBe('post_launch')
    expect(reduceSimLaunch(launching.state, ready(1))).toEqual({
      state: { phase: 'launching', attempt: 1 },
    })
  })

  test('ready after the code expired launches nothing', () => {
    const awaiting = run(SIM_IDLE, { type: 'start' }, grant(1))
    expect(reduceSimLaunch(awaiting.state, ready(1, NOW + 61_000))).toEqual({
      state: { phase: 'unavailable', attempt: 1, reason: 'frame_timeout' },
    })
  })

  test('frame messages before a launch cannot move the state', () => {
    for (const message of [
      { type: 'frame.state', payload: { state: 'running' } },
      { type: 'frame.error', payload: { code: 'engine_failed' } },
    ] as SimFrameMessage[]) {
      expect(reduceSimLaunch(SIM_IDLE, frame(0, message)).state).toEqual(SIM_IDLE)
      const requesting: SimLaunchState = { phase: 'requesting', attempt: 1 }
      expect(reduceSimLaunch(requesting, frame(1, message)).state).toEqual(requesting)
    }
  })

  test('denials, outages and malformed replies name a cause', () => {
    const requesting: SimLaunchState = { phase: 'requesting', attempt: 1 }
    const reply = (value: Parameters<typeof reduceSimLaunch>[1] extends infer E ? E : never) =>
      reduceSimLaunch(requesting, value).state
    expect(
      reply({ type: 'grant', attempt: 1, grant: { status: 'denied', reason: 'not_entitled' } })
    ).toEqual({ phase: 'unavailable', attempt: 1, reason: 'not_entitled' })
    expect(
      reply({
        type: 'grant',
        attempt: 1,
        grant: { status: 'unavailable', reason: 'not_configured' },
      })
    ).toEqual({ phase: 'unavailable', attempt: 1, reason: 'not_configured' })
    expect(reply({ type: 'grant', attempt: 1, grant: null })).toEqual({
      phase: 'unavailable',
      attempt: 1,
      reason: 'service_unavailable',
    })
    expect(reduceSimLaunch(SIM_IDLE, grant(0)).state).toEqual(SIM_IDLE)
  })

  test('a frame that fails before it reports ready fails the attempt', () => {
    const awaiting = run(SIM_IDLE, { type: 'start' }, grant(1)).state
    expect(awaiting.phase).toBe('awaiting_frame')
    expect(
      reduceSimLaunch(
        awaiting,
        frame(1, { type: 'frame.error', payload: { code: 'bridge_incompatible' } })
      ).state
    ).toEqual({ phase: 'unavailable', attempt: 1, reason: 'bridge_incompatible' })
    // A stale attempt's error still cannot touch the current one.
    expect(
      reduceSimLaunch(
        awaiting,
        frame(0, { type: 'frame.error', payload: { code: 'bridge_incompatible' } })
      ).state
    ).toEqual(awaiting)
  })

  test('frame errors, timeouts and offline are distinct, retryable ends', () => {
    const launching = run(SIM_IDLE, { type: 'start' }, grant(1), ready(1)).state
    expect(
      reduceSimLaunch(
        launching,
        frame(1, { type: 'frame.error', payload: { code: 'asset_unavailable' } })
      ).state
    ).toEqual({ phase: 'unavailable', attempt: 1, reason: 'service_unavailable' })
    expect(reduceSimLaunch(launching, { type: 'timeout', attempt: 1 }).state).toEqual({
      phase: 'unavailable',
      attempt: 1,
      reason: 'frame_timeout',
    })
    expect(reduceSimLaunch(launching, { type: 'offline' }).state).toEqual({
      phase: 'offline',
      attempt: 1,
    })
    const running: SimLaunchState = { phase: 'running', attempt: 1 }
    expect(reduceSimLaunch(running, { type: 'timeout', attempt: 1 }).state).toEqual(running)
    expect(reduceSimLaunch({ phase: 'offline', attempt: 1 }, { type: 'start' }).state).toEqual({
      phase: 'requesting',
      attempt: 2,
    })
    expect(
      reduceSimLaunch(
        { phase: 'unavailable', attempt: 1, reason: 'engine_failed' },
        { type: 'start' }
      ).effect
    ).toEqual({ type: 'request_grant', attempt: 2 })
    expect(reduceSimLaunch(SIM_IDLE, { type: 'offline' }).state).toEqual(SIM_IDLE)
  })

  test('dispose and close return to idle; dispose tells the frame', () => {
    const running: SimLaunchState = { phase: 'running', attempt: 3 }
    expect(reduceSimLaunch(running, { type: 'dispose' })).toEqual({
      state: { phase: 'idle', attempt: 3 },
      effect: { type: 'dispose_frame', attempt: 3 },
    })
    expect(reduceSimLaunch(running, frame(3, { type: 'frame.close', payload: {} })).state).toEqual({
      phase: 'idle',
      attempt: 3,
    })
    expect(reduceSimLaunch(SIM_IDLE, { type: 'dispose' })).toEqual({ state: SIM_IDLE })
  })

  test('start does not interrupt a launch in flight or change its attempt', () => {
    for (const state of [
      { phase: 'requesting', attempt: 4 },
      { phase: 'launching', attempt: 4 },
      { phase: 'running', attempt: 4 },
    ] as SimLaunchState[])
      expect(reduceSimLaunch(state, { type: 'start' })).toEqual({ state })
  })

  describe('attempt fencing', () => {
    test('a late grant for an interrupted attempt cannot start the next one', () => {
      for (const interrupt of [{ type: 'dispose' }, { type: 'offline' }] as const) {
        let step = reduceSimLaunch(SIM_IDLE, { type: 'start' }) // attempt 1
        step = reduceSimLaunch(step.state, interrupt)
        step = reduceSimLaunch(step.state, { type: 'start' }) // attempt 2
        expect(step.state).toEqual({ phase: 'requesting', attempt: 2 })
        // Attempt 1's reply arrives while attempt 2 is requesting.
        const late = reduceSimLaunch(step.state, grant(1))
        expect(late).toEqual({ state: { phase: 'requesting', attempt: 2 } })
        const lateDenied = reduceSimLaunch(step.state, {
          type: 'grant',
          attempt: 1,
          grant: { status: 'denied', reason: 'not_entitled' },
        })
        expect(lateDenied.state).toEqual({ phase: 'requesting', attempt: 2 })
        // Attempt 2's own reply still works.
        expect(reduceSimLaunch(step.state, grant(2)).state.phase).toBe('awaiting_frame')
      }
    })

    test('repeated starts after failures keep counting up and fence every earlier attempt', () => {
      let state: SimLaunchState = SIM_IDLE
      for (let attempt = 1; attempt <= 3; attempt++) {
        state = reduceSimLaunch(state, { type: 'start' }).state
        expect(state).toEqual({ phase: 'requesting', attempt })
        state = reduceSimLaunch(state, { type: 'grant', attempt, grant: null }).state
        expect(state.phase).toBe('unavailable')
      }
      state = reduceSimLaunch(state, { type: 'start' }).state // attempt 4
      for (const stale of [1, 2, 3, 5])
        expect(reduceSimLaunch(state, grant(stale)).state).toEqual({
          phase: 'requesting',
          attempt: 4,
        })
    })

    test('a stale timeout cannot fail a newer attempt', () => {
      let step = reduceSimLaunch(SIM_IDLE, { type: 'start' })
      step = reduceSimLaunch(step.state, grant(1))
      step = reduceSimLaunch(step.state, { type: 'dispose' })
      step = reduceSimLaunch(step.state, { type: 'start' })
      step = reduceSimLaunch(step.state, grant(2))
      expect(reduceSimLaunch(step.state, { type: 'timeout', attempt: 1 }).state).toEqual(step.state)
      expect(reduceSimLaunch(step.state, { type: 'timeout', attempt: 2 }).state).toEqual({
        phase: 'unavailable',
        attempt: 2,
        reason: 'frame_timeout',
      })
    })

    test('a stale frame cannot launch, fail or close a newer attempt', () => {
      let step = reduceSimLaunch(SIM_IDLE, { type: 'start' })
      step = reduceSimLaunch(step.state, grant(1))
      step = reduceSimLaunch(step.state, { type: 'offline' })
      step = reduceSimLaunch(step.state, { type: 'start' })
      step = reduceSimLaunch(step.state, grant(2))
      const awaiting = step.state
      // The old frame's ready must not make attempt 2 post its code to the wrong frame.
      expect(reduceSimLaunch(awaiting, ready(1))).toEqual({ state: awaiting })

      const launching = reduceSimLaunch(awaiting, ready(2)).state
      for (const message of [
        { type: 'frame.state', payload: { state: 'running' } },
        { type: 'frame.state', payload: { state: 'offline' } },
        { type: 'frame.error', payload: { code: 'engine_failed' } },
        { type: 'frame.close', payload: {} },
      ] as SimFrameMessage[])
        expect(reduceSimLaunch(launching, frame(1, message))).toEqual({ state: launching })
    })
  })

  test('every unavailable reason has copy that keeps Chat and Dev independent', () => {
    for (const reason of SIM_UNAVAILABLE_REASONS) {
      const notice = describeSimAvailability({ phase: 'unavailable', attempt: 1, reason })
      expect(notice?.tone).toBe('error')
      expect(notice?.detail).toContain('Chat and Dev are not affected')
      expect(notice?.title.length).toBeGreaterThan(0)
    }
    const offline = describeSimAvailability({ phase: 'offline', attempt: 1 })
    expect(offline?.title).toBe('Agent Sim is offline')
    expect(offline?.retryable).toBe(true)
    expect(
      describeSimAvailability({ phase: 'unavailable', attempt: 1, reason: 'not_entitled' })
        ?.retryable
    ).toBe(false)
    expect(describeSimAvailability({ phase: 'launching', attempt: 1 })?.tone).toBe('neutral')
    expect(describeSimAvailability(SIM_IDLE)).toBeNull()
    expect(describeSimAvailability({ phase: 'running', attempt: 1 })).toBeNull()
  })
})

describe('session cookie', () => {
  const value = 's'.repeat(43)

  test('builds a host-prefixed, partitioned, HttpOnly cookie that satisfies its own invariants', () => {
    const header = buildSimSessionSetCookie(value, 900)
    expect(header).toBe(
      `${SIM_SESSION_COOKIE_NAME}=${value}; Max-Age=900; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`
    )
    expect(simSessionCookieViolations(header)).toEqual([])
    expect(simSessionCookieViolations(buildSimSessionClearCookie())).toEqual([])
    expect(buildSimSessionClearCookie()).toContain('Max-Age=0')
  })

  test('refuses unsafe values and lifetimes', () => {
    for (const bad of [
      '',
      'short',
      `${value};Domain=x`,
      `${value} `,
      `${value}\r\nSet-Cookie: x=y`,
    ])
      expect(() => buildSimSessionSetCookie(bad, 60)).toThrow()
    for (const seconds of [0, -1, 3601, 1.5, Number.NaN])
      expect(() => buildSimSessionSetCookie(value, seconds)).toThrow()
  })

  test('flags every departure from the contract', () => {
    const base = buildSimSessionSetCookie(value, 60)
    expect(simSessionCookieViolations(base.replace('; Secure', ''))).toContain('secure')
    expect(simSessionCookieViolations(base.replace('; HttpOnly', ''))).toContain('httponly')
    expect(simSessionCookieViolations(base.replace('; Partitioned', ''))).toContain('partitioned')
    expect(simSessionCookieViolations(base.replace('SameSite=None', 'SameSite=Lax'))).toContain(
      'samesite'
    )
    expect(simSessionCookieViolations(`${base}; Domain=adea.example`)).toContain('domain')
    expect(simSessionCookieViolations(base.replace('Path=/', 'Path=/sim'))).toContain('path')
    expect(simSessionCookieViolations(base.replace('Max-Age=60', 'Max-Age=7200'))).toContain(
      'max-age'
    )
    expect(simSessionCookieViolations(base.replace('__Host-', ''))).toContain('name')
    expect(simSessionCookieViolations(`${base}; Secure`)).toContain('duplicate:secure')
  })

  test('reads exactly one well-formed cookie', () => {
    expect(readSimSessionCookie(`a=1; ${SIM_SESSION_COOKIE_NAME}=${value}; b=2`)).toBe(value)
    expect(readSimSessionCookie(null)).toBeNull()
    expect(readSimSessionCookie('a=1')).toBeNull()
    expect(readSimSessionCookie(`${SIM_SESSION_COOKIE_NAME}=short`)).toBeNull()
    expect(
      readSimSessionCookie(
        `${SIM_SESSION_COOKIE_NAME}=${value}; ${SIM_SESSION_COOKIE_NAME}=${'t'.repeat(43)}`
      )
    ).toBeNull()
    expect(readSimSessionCookie(`x${SIM_SESSION_COOKIE_NAME}=${value}`)).toBeNull()
  })
})

describe('local bootstrap flow', () => {
  test('entitled launch reaches a sim-only session with no token anywhere', () => {
    const bridgeId = createBridgeId()
    const channel = wire()
    const ledger = createLaunchCodeLedger()
    const expiresAtMs = NOW + 60_000
    ledger.issue(CODE, { bridgeId, origin: SIM, surface: 'hq' }, expiresAtMs)

    // Backend grant (parsed by the host).
    const grant = parseSimLaunchGrant(
      {
        status: 'granted',
        code: CODE,
        expiresAt: new Date(expiresAtMs).toISOString(),
        surface: 'hq',
        frameOrigin: SIM,
      },
      { origins, now: NOW, surface: 'hq' }
    )
    let step = reduceSimLaunch(SIM_IDLE, { type: 'start' })
    step = reduceSimLaunch(step.state, { type: 'grant', attempt: 1, grant })

    // Frame says ready; host validates and posts the launch.
    postToHost(channel.toHost, HOST, bridgeId, { type: 'frame.ready', payload: {} })
    const readyEvent = channel.hostInbox[0] as {
      origin: string
      source: unknown
      data: unknown
      target: string
    }
    expect(readyEvent.target).toBe(HOST)
    const ready = parseFrameMessage(readyEvent, {
      origins,
      frameWindow: channel.simWindow,
      bridgeId,
    })
    if (!ready.ok) throw new Error(ready.reason)
    step = reduceSimLaunch(step.state, {
      type: 'frame',
      attempt: 1,
      message: ready.message,
      now: NOW,
    })
    if (step.effect?.type !== 'post_launch') throw new Error('expected a launch')
    const { code, expiresAt, surface } = step.effect.grant
    postToFrame(channel.toFrame, step.effect.grant.frameOrigin, origins, bridgeId, {
      type: 'host.launch',
      payload: { code, expiresAt, surface },
    })

    // Frame validates, honours the launch once, then exchanges at the sim origin.
    const launchEvent = channel.frameInbox[0] as { target: string }
    expect(launchEvent.target).toBe(SIM)
    const launch = parseHostMessage(launchEvent as never, {
      parentOrigin: HOST,
      parentWindow: channel.hostWindow,
      bridgeId,
    })
    if (!launch.ok || launch.message.type !== 'host.launch') throw new Error('expected launch')
    const once = createLaunchOnce()
    const payload = once.take(launch.message.payload, NOW)
    expect(payload).not.toBeNull()
    const exchange = { schemaVersion: 1 as const, code: payload!.code, bridgeId }
    expect(parseSimSessionExchangeRequest(exchange)).toEqual(exchange)
    expect(JSON.stringify(exchange)).not.toMatch(/token|secret|password/i)

    const redeemed = ledger.redeem(exchange.code, { bridgeId, origin: SIM }, NOW)
    expect(redeemed).toEqual({ ok: true, surface: 'hq' })
    const setCookie = buildSimSessionSetCookie('s'.repeat(43), 900)
    expect(simSessionCookieViolations(setCookie)).toEqual([])
    const body = parseSimSessionExchangeResult({ status: 'session', expiresAt: iso(900_000) })
    expect(body).toEqual({ status: 'session', expiresAt: iso(900_000) })
    expect(JSON.stringify(body)).not.toContain('s'.repeat(43))

    // Frame reports running; the host reaches running only now.
    postToHost(channel.toHost, HOST, bridgeId, {
      type: 'frame.state',
      payload: { state: 'running' },
    })
    const running = parseFrameMessage(channel.hostInbox[1] as never, {
      origins,
      frameWindow: channel.simWindow,
      bridgeId,
    })
    if (!running.ok) throw new Error(running.reason)
    expect(
      reduceSimLaunch(step.state, { type: 'frame', attempt: 1, message: running.message, now: NOW })
        .state
    ).toEqual({
      phase: 'running',
      attempt: 1,
    })
  })

  test('a replayed launch and a replayed code are both refused', () => {
    const bridgeId = createBridgeId()
    const ledger = createLaunchCodeLedger()
    ledger.issue(CODE, { bridgeId, origin: SIM, surface: 'hq' }, NOW + 60_000)
    const payload = { code: CODE, expiresAt: iso(60_000), surface: 'hq' as const }
    const once = createLaunchOnce()
    expect(once.take(payload, NOW)).not.toBeNull()
    expect(once.take(payload, NOW)).toBeNull()
    expect(ledger.redeem(CODE, { bridgeId, origin: SIM }, NOW).ok).toBe(true)
    expect(ledger.redeem(CODE, { bridgeId, origin: SIM }, NOW)).toEqual({
      ok: false,
      reason: 'code_used',
    })
  })

  test('a hostile sibling window or origin cannot drive the host', () => {
    const bridgeId = createBridgeId()
    const channel = wire()
    const data = frameEnvelope(bridgeId, { type: 'frame.state', payload: { state: 'running' } })
    const hostile = [
      { origin: SIM, source: { id: 'other-frame' }, data },
      { origin: 'https://evil.example', source: channel.simWindow, data },
      { origin: 'null', source: channel.simWindow, data },
    ]
    for (const event of hostile)
      expect(
        parseFrameMessage(event, { origins, frameWindow: channel.simWindow, bridgeId }).ok
      ).toBe(false)
  })

  test('an offline host stays truthful and leaves other surfaces alone', () => {
    const step = reduceSimLaunch({ phase: 'launching', attempt: 1 }, { type: 'offline' })
    expect(describeSimAvailability(step.state)?.detail).toContain('Chat and Dev are not affected')
  })
})
