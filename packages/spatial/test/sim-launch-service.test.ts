import { describe, expect, test } from 'bun:test'
import {
  MAX_SIM_LAUNCH_TTL_MS,
  SIM_SESSION_COOKIE_NAME,
  createLaunchCodeLedger,
  createOriginAllowlist,
  createSimLaunchIssuer,
  createSimSessionExchange,
  parseSimLaunchGrant,
  parseSimSessionExchangeResult,
  simSessionCookieViolations,
  type SimEntitlementQuery,
  type SimEntitlementVerdict,
  type SimLaunchCodeStore,
  type SimSessionRecord,
} from '../src/sim-bridge'

const SIM = 'https://sim.adea.example'
const BRIDGE = 'AbCdEfGhIjKlMnOpQrSt'
const NOW = Date.parse('2026-10-17T12:00:00.000Z')
const request = {
  schemaVersion: 1,
  workspaceId: 'ws_1',
  surface: 'hq',
  platform: 'web',
  bridgeId: BRIDGE,
}

function counter() {
  let n = 0
  return (length: number) => new Uint8Array(length).fill(++n)
}

function world(
  overrides: { verdict?: SimEntitlementVerdict | 'throw'; origin?: string | null } = {}
) {
  const queries: SimEntitlementQuery[] = []
  const sessions = new Map<string, SimSessionRecord>()
  let clock = NOW
  const store = createLaunchCodeLedger()
  const random = counter()
  const issue = createSimLaunchIssuer({
    frameOrigin: 'origin' in overrides ? overrides.origin : SIM,
    entitlement: (query) => {
      queries.push(query)
      if (overrides.verdict === 'throw') throw new Error('entitlement down')
      return overrides.verdict ?? 'entitled'
    },
    store,
    now: () => clock,
    randomBytes: random,
  })
  const exchange = createSimSessionExchange({
    origin: SIM,
    store,
    sessions: { save: (value, record) => void sessions.set(value, record) },
    now: () => clock,
    randomBytes: random,
  })
  return { issue, exchange, queries, sessions, store, advance: (ms: number) => void (clock += ms) }
}

const exchangeBody = (code: string, bridgeId = BRIDGE) => ({ schemaVersion: 1, code, bridgeId })

const loopbackIssuer = (allowLoopbackHttp?: boolean) =>
  createSimLaunchIssuer({
    frameOrigin: 'http://localhost:4100',
    allowLoopbackHttp,
    entitlement: () => 'entitled',
    store: createLaunchCodeLedger(),
  })

const expectation = (surface: 'hq' | 'character-designer' | 'room-designer' = 'hq') => ({
  origins: createOriginAllowlist([SIM]),
  now: NOW,
  surface,
})

describe('launch issuer', () => {
  test('an entitled launch yields a grant the host parser accepts', async () => {
    const w = world()
    const grant = await w.issue(request)
    expect(grant.status).toBe('granted')
    expect(parseSimLaunchGrant(grant, expectation())).toEqual(grant)
    expect(w.queries).toEqual([{ workspaceId: 'ws_1', surface: 'hq', platform: 'web' }])
  })

  test('the code lifetime is bounded by the contract', async () => {
    const long = createSimLaunchIssuer({
      frameOrigin: SIM,
      entitlement: () => 'entitled',
      store: createLaunchCodeLedger(),
      codeTtlMs: 10 * MAX_SIM_LAUNCH_TTL_MS,
      now: () => NOW,
    })
    const grant = await long(request)
    expect(grant.status === 'granted' && Date.parse(grant.expiresAt)).toBe(
      NOW + MAX_SIM_LAUNCH_TTL_MS
    )
    expect(parseSimLaunchGrant(grant, expectation())).not.toBeNull()
  })

  test('every code is distinct and unguessable in shape', async () => {
    const w = world()
    const a = await w.issue(request)
    const b = await w.issue(request)
    expect(a.status === 'granted' && b.status === 'granted' && a.code !== b.code).toBe(true)
  })

  test.each([
    ['unauthenticated', { status: 'denied', reason: 'unauthenticated' }],
    ['not_entitled', { status: 'denied', reason: 'not_entitled' }],
    ['unavailable', { status: 'unavailable', reason: 'service_unavailable' }],
    ['throw', { status: 'unavailable', reason: 'service_unavailable' }],
  ] as const)('a %s verdict issues no code', async (verdict, expected) => {
    const w = world({ verdict })
    expect(await w.issue(request)).toEqual(expected)
    // Nothing was stored: a code can never be redeemed after a refusal.
    expect(w.store.redeem('x'.repeat(43), { bridgeId: BRIDGE, origin: SIM }, NOW)).toEqual({
      ok: false,
      reason: 'unknown',
    })
  })

  test('an unrecognised verdict fails closed', async () => {
    const w = createSimLaunchIssuer({
      frameOrigin: SIM,
      entitlement: () => 'yes' as unknown as SimEntitlementVerdict,
      store: createLaunchCodeLedger(),
    })
    expect(await w(request)).toEqual({ status: 'unavailable', reason: 'service_unavailable' })
  })

  test.each([null, undefined, '', 'https://*.adea.example', 'http://sim.adea.example', `${SIM}/`])(
    'sim origin %p is not configured and does not reach the entitlement source',
    async (origin) => {
      const w = world({ origin })
      expect(await w.issue(request)).toEqual({ status: 'unavailable', reason: 'not_configured' })
      expect(w.queries).toEqual([])
    }
  )

  test('loopback http needs the explicit opt-in', async () => {
    expect((await loopbackIssuer()(request)).status).toBe('unavailable')
    expect((await loopbackIssuer(true)(request)).status).toBe('granted')
  })

  test('a store failure is unavailable, not granted', async () => {
    const store: SimLaunchCodeStore = {
      issue: () => Promise.reject(new Error('down')),
      redeem: () => ({ ok: false, reason: 'unknown' }),
    }
    const issue = createSimLaunchIssuer({ frameOrigin: SIM, entitlement: () => 'entitled', store })
    expect(await issue(request)).toEqual({ status: 'unavailable', reason: 'service_unavailable' })
  })

  test('malformed requests are refused before the entitlement source is asked', async () => {
    const w = world()
    for (const body of [
      null,
      'hq',
      { ...request, surface: 'admin' },
      { ...request, accountId: 'acct_1' },
      { ...request, bridgeId: 'short' },
    ])
      expect(await w.issue(body)).toEqual({ status: 'invalid_request' })
    expect(w.queries).toEqual([])
  })
})

describe('session exchange', () => {
  test('a granted code becomes one conforming sim-only cookie and no token in the body', async () => {
    const w = world()
    const grant = await w.issue(request)
    if (grant.status !== 'granted') throw new Error('expected a grant')
    const response = await w.exchange(exchangeBody(grant.code))
    expect(parseSimSessionExchangeResult(response.body)).toEqual(response.body)
    expect(response.body.status).toBe('session')
    expect(Object.keys(response.body).toSorted()).toEqual(['expiresAt', 'status'])
    expect(response.setCookie).toBeDefined()
    expect(simSessionCookieViolations(response.setCookie!)).toEqual([])
    expect(response.setCookie!.startsWith(`${SIM_SESSION_COOKIE_NAME}=`)).toBe(true)
    const value = response.setCookie!.split(';')[0]!.split('=')[1]!
    expect(JSON.stringify(response.body)).not.toContain(value)
    expect(w.sessions.get(value)?.surface).toBe('hq')
  })

  test('the session surface is the surface that was granted', async () => {
    const w = world()
    const grant = await w.issue({ ...request, surface: 'room-designer' })
    if (grant.status !== 'granted') throw new Error('expected a grant')
    const response = await w.exchange(exchangeBody(grant.code))
    const value = response.setCookie!.split(';')[0]!.split('=')[1]!
    expect(w.sessions.get(value)?.surface).toBe('room-designer')
  })

  test('a code redeems once; a replay gets no cookie', async () => {
    const w = world()
    const grant = await w.issue(request)
    if (grant.status !== 'granted') throw new Error('expected a grant')
    expect((await w.exchange(exchangeBody(grant.code))).body.status).toBe('session')
    const replay = await w.exchange(exchangeBody(grant.code))
    expect(replay).toEqual({ body: { status: 'rejected', reason: 'code_used' } })
    expect(w.sessions.size).toBe(1)
  })

  test('an expired code gets no cookie', async () => {
    const w = world()
    const grant = await w.issue(request)
    if (grant.status !== 'granted') throw new Error('expected a grant')
    w.advance(MAX_SIM_LAUNCH_TTL_MS)
    expect(await w.exchange(exchangeBody(grant.code))).toEqual({
      body: { status: 'rejected', reason: 'code_expired' },
    })
    expect(w.sessions.size).toBe(0)
  })

  test('a code presented with another bridge id is refused and spent', async () => {
    const w = world()
    const grant = await w.issue(request)
    if (grant.status !== 'granted') throw new Error('expected a grant')
    expect(await w.exchange(exchangeBody(grant.code, 'ZyXwVuTsRqPoNmLkJiHg'))).toEqual({
      body: { status: 'rejected', reason: 'origin_refused' },
    })
    expect((await w.exchange(exchangeBody(grant.code))).body).toEqual({
      status: 'rejected',
      reason: 'code_used',
    })
    expect(w.sessions.size).toBe(0)
  })

  test('a code issued for another sim origin is not redeemable here', async () => {
    const store = createLaunchCodeLedger()
    const issue = createSimLaunchIssuer({
      frameOrigin: 'https://other-sim.adea.example',
      entitlement: () => 'entitled',
      store,
    })
    const grant = await issue(request)
    if (grant.status !== 'granted') throw new Error('expected a grant')
    const sessions = new Map<string, SimSessionRecord>()
    const exchange = createSimSessionExchange({
      origin: SIM,
      store,
      sessions: { save: (value, record) => void sessions.set(value, record) },
    })
    expect((await exchange(exchangeBody(grant.code))).body).toEqual({
      status: 'rejected',
      reason: 'origin_refused',
    })
    expect(sessions.size).toBe(0)
  })

  test('an unknown code looks like an expired one', async () => {
    const w = world()
    expect((await w.exchange(exchangeBody('u'.repeat(43)))).body).toEqual({
      status: 'rejected',
      reason: 'code_expired',
    })
  })

  test('session lifetime is clamped to the contract and matches the cookie', async () => {
    const store = createLaunchCodeLedger()
    const issue = createSimLaunchIssuer({
      frameOrigin: SIM,
      entitlement: () => 'entitled',
      store,
      now: () => NOW,
    })
    const grant = await issue(request)
    if (grant.status !== 'granted') throw new Error('expected a grant')
    const exchange = createSimSessionExchange({
      origin: SIM,
      store,
      sessions: { save: () => {} },
      sessionSeconds: 10 ** 6,
      now: () => NOW,
    })
    const response = await exchange(exchangeBody(grant.code))
    expect(response.setCookie).toContain('Max-Age=3600')
    expect(response.body.status === 'session' && Date.parse(response.body.expiresAt)).toBe(
      NOW + 3_600_000
    )
  })

  test('store and session-store failures are unavailable and set no cookie', async () => {
    const broken = createSimSessionExchange({
      origin: SIM,
      store: { issue: () => {}, redeem: () => Promise.reject(new Error('down')) },
      sessions: { save: () => {} },
    })
    expect(await broken(exchangeBody('c'.repeat(43)))).toEqual({ body: { status: 'unavailable' } })

    const store = createLaunchCodeLedger()
    const issue = createSimLaunchIssuer({ frameOrigin: SIM, entitlement: () => 'entitled', store })
    const grant = await issue(request)
    if (grant.status !== 'granted') throw new Error('expected a grant')
    const noSessions = createSimSessionExchange({
      origin: SIM,
      store,
      sessions: { save: () => Promise.reject(new Error('down')) },
    })
    expect(await noSessions(exchangeBody(grant.code))).toEqual({ body: { status: 'unavailable' } })
  })

  test('an unconfigured sim origin is unavailable and malformed bodies are invalid', async () => {
    const exchange = createSimSessionExchange({
      origin: null,
      store: createLaunchCodeLedger(),
      sessions: { save: () => {} },
    })
    expect(await exchange(exchangeBody('c'.repeat(43)))).toEqual({
      body: { status: 'unavailable' },
    })
    const w = world()
    for (const body of [null, { code: 'x' }, { ...exchangeBody('c'.repeat(43)), token: 't' }])
      expect(await w.exchange(body)).toEqual({ body: { status: 'invalid_request' } })
  })
})

// Misconfigured or hostile injected inputs fail closed, and they fail before anything is stored or
// any code is spent.
const BAD_CLOCKS: ReadonlyArray<readonly [string, () => number]> = [
  ['NaN', () => Number.NaN],
  ['Infinity', () => Number.POSITIVE_INFINITY],
  ['-Infinity', () => Number.NEGATIVE_INFINITY],
  ['a string', () => '1700000000000' as unknown as number],
  ['past the Date range once the lifetime is added', () => 8.64e15],
  [
    'a throw',
    () => {
      throw new Error('clock down')
    },
  ],
]

const BAD_LIFETIMES: ReadonlyArray<readonly [string, number]> = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['a string', '60' as unknown as number],
]

/** A store that records every call and delegates to the reference ledger. */
function spyStore() {
  const ledger = createLaunchCodeLedger()
  const calls = { issue: 0, redeem: 0 }
  const store: SimLaunchCodeStore = {
    issue: (code, binding, expiresAt) => {
      calls.issue += 1
      return ledger.issue(code, binding, expiresAt)
    },
    redeem: (code, presented, now) => {
      calls.redeem += 1
      return ledger.redeem(code, presented, now)
    },
  }
  return { store, calls }
}

async function grantFor(store: SimLaunchCodeStore) {
  const grant = await createSimLaunchIssuer({
    frameOrigin: SIM,
    entitlement: () => 'entitled',
    store,
    now: () => NOW,
  })(request)
  if (grant.status !== 'granted') throw new Error('expected a grant')
  return grant
}

describe('invalid lifetimes, clocks and dates', () => {
  test.each(BAD_LIFETIMES)(
    'issuer: a code lifetime of %s is not configured and asks nothing',
    async (_label, codeTtlMs) => {
      const { store, calls } = spyStore()
      let asked = 0
      const issue = createSimLaunchIssuer({
        frameOrigin: SIM,
        entitlement: () => (asked++, 'entitled'),
        store,
        codeTtlMs,
        now: () => NOW,
      })
      expect(await issue(request)).toEqual({ status: 'unavailable', reason: 'not_configured' })
      expect(asked).toBe(0)
      expect(calls.issue).toBe(0)
    }
  )

  test.each(BAD_CLOCKS)(
    'issuer: a clock reading of %s is unavailable and nothing is stored',
    async (_label, now) => {
      const { store, calls } = spyStore()
      const issue = createSimLaunchIssuer({
        frameOrigin: SIM,
        entitlement: () => 'entitled',
        store,
        now,
      })
      expect(await issue(request)).toEqual({ status: 'unavailable', reason: 'service_unavailable' })
      expect(calls.issue).toBe(0)
    }
  )

  test('issuer: a failing random source stores nothing', async () => {
    const { store, calls } = spyStore()
    const issue = createSimLaunchIssuer({
      frameOrigin: SIM,
      entitlement: () => 'entitled',
      store,
      now: () => NOW,
      randomBytes: () => {
        throw new Error('entropy down')
      },
    })
    expect(await issue(request)).toEqual({ status: 'unavailable', reason: 'service_unavailable' })
    expect(calls.issue).toBe(0)
  })

  test('finite lifetimes below one are raised to the minimum, not rejected', async () => {
    const issue = createSimLaunchIssuer({
      frameOrigin: SIM,
      entitlement: () => 'entitled',
      store: createLaunchCodeLedger(),
      codeTtlMs: -5,
      now: () => NOW,
    })
    const grant = await issue(request)
    expect(grant.status === 'granted' && Date.parse(grant.expiresAt)).toBe(NOW + 1)
  })

  test.each(BAD_LIFETIMES)(
    'exchange: a session lifetime of %s is unavailable and spends no code',
    async (_label, sessionSeconds) => {
      const { store, calls } = spyStore()
      const grant = await grantFor(store)
      const sessions = new Map<string, SimSessionRecord>()
      const save = (value: string, record: SimSessionRecord) => void sessions.set(value, record)
      const broken = createSimSessionExchange({
        origin: SIM,
        store,
        sessions: { save },
        sessionSeconds,
        now: () => NOW,
      })
      expect(await broken(exchangeBody(grant.code))).toEqual({ body: { status: 'unavailable' } })
      expect(calls.redeem).toBe(0)
      expect(sessions.size).toBe(0)

      const good = createSimSessionExchange({
        origin: SIM,
        store,
        sessions: { save },
        now: () => NOW,
      })
      expect((await good(exchangeBody(grant.code))).body.status).toBe('session')
    }
  )

  test.each(BAD_CLOCKS)(
    'exchange: a clock reading of %s is unavailable, spends no code and saves no session',
    async (_label, now) => {
      const { store, calls } = spyStore()
      const grant = await grantFor(store)
      const sessions = new Map<string, SimSessionRecord>()
      const save = (value: string, record: SimSessionRecord) => void sessions.set(value, record)
      const broken = createSimSessionExchange({ origin: SIM, store, sessions: { save }, now })
      expect(await broken(exchangeBody(grant.code))).toEqual({ body: { status: 'unavailable' } })
      expect(calls.redeem).toBe(0)
      expect(sessions.size).toBe(0)

      // The code was not consumed, so a healthy exchange can still redeem it.
      const good = createSimSessionExchange({
        origin: SIM,
        store,
        sessions: { save },
        now: () => NOW,
      })
      expect((await good(exchangeBody(grant.code))).body.status).toBe('session')
      expect(sessions.size).toBe(1)
    }
  )

  test('exchange: a failing random source spends no code', async () => {
    const { store, calls } = spyStore()
    const grant = await grantFor(store)
    const broken = createSimSessionExchange({
      origin: SIM,
      store,
      sessions: { save: () => {} },
      now: () => NOW,
      randomBytes: () => {
        throw new Error('entropy down')
      },
    })
    expect(await broken(exchangeBody(grant.code))).toEqual({ body: { status: 'unavailable' } })
    expect(calls.redeem).toBe(0)
  })

  test('the reference ledger fails closed on an unusable clock without spending the code', () => {
    const ledger = createLaunchCodeLedger()
    const binding = { bridgeId: BRIDGE, origin: SIM, surface: 'hq' } as const
    ledger.issue('code', binding, NOW + 1000)
    const presented = { bridgeId: BRIDGE, origin: SIM }
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(ledger.redeem('code', presented, now)).toEqual({ ok: false, reason: 'code_expired' })
    expect(ledger.redeem('code', presented, NOW)).toEqual({ ok: true, surface: 'hq' })
  })

  test('the reference ledger refuses a non-finite expiry instead of storing it', () => {
    const ledger = createLaunchCodeLedger()
    const binding = { bridgeId: BRIDGE, origin: SIM, surface: 'hq' } as const
    for (const expiresAt of [Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => ledger.issue('code', binding, expiresAt)).toThrow(RangeError)
    expect(ledger.redeem('code', { bridgeId: BRIDGE, origin: SIM }, NOW)).toEqual({
      ok: false,
      reason: 'unknown',
    })
  })
})

describe('port contract under concurrency and failure', () => {
  test('concurrent exchanges of one code produce exactly one session', async () => {
    const ledger = createLaunchCodeLedger()
    // An asynchronous store: each call yields before reaching the (atomic) ledger operation.
    const store: SimLaunchCodeStore = {
      issue: async (code, binding, expiresAt) => {
        await Promise.resolve()
        ledger.issue(code, binding, expiresAt)
      },
      redeem: async (code, presented, now) => {
        await Promise.resolve()
        return ledger.redeem(code, presented, now)
      },
    }
    const grant = await grantFor(store)
    const sessions = new Map<string, SimSessionRecord>()
    const exchange = createSimSessionExchange({
      origin: SIM,
      store,
      sessions: { save: (value, record) => void sessions.set(value, record) },
      now: () => NOW,
      randomBytes: counter(),
    })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => exchange(exchangeBody(grant.code)))
    )
    expect(results.filter((r) => r.body.status === 'session')).toHaveLength(1)
    expect(results.filter((r) => r.setCookie !== undefined)).toHaveLength(1)
    expect(
      results.filter((r) => r.body.status === 'rejected' && r.body.reason === 'code_used')
    ).toHaveLength(4)
    expect(sessions.size).toBe(1)
  })

  test('a failed session save spends the code, so a retry gets no session and a new launch works', async () => {
    const store = createLaunchCodeLedger()
    const sessions = new Map<string, SimSessionRecord>()
    let failSave = true
    const exchange = createSimSessionExchange({
      origin: SIM,
      store,
      sessions: {
        save: (value, record) => {
          if (failSave) return Promise.reject(new Error('down'))
          sessions.set(value, record)
        },
      },
      now: () => NOW,
      randomBytes: counter(),
    })
    const grant = await grantFor(store)

    expect(await exchange(exchangeBody(grant.code))).toEqual({ body: { status: 'unavailable' } })
    expect(sessions.size).toBe(0)

    failSave = false
    expect(await exchange(exchangeBody(grant.code))).toEqual({
      body: { status: 'rejected', reason: 'code_used' },
    })
    expect(sessions.size).toBe(0)

    const next = await createSimLaunchIssuer({
      frameOrigin: SIM,
      entitlement: () => 'entitled',
      store,
      now: () => NOW,
      randomBytes: counter(),
    })(request)
    if (next.status !== 'granted') throw new Error('expected a grant')
    const retried = await exchange(exchangeBody(next.code))
    expect(retried.body.status).toBe('session')
    expect(retried.setCookie).toBeDefined()
    expect(sessions.size).toBe(1)
  })
})
