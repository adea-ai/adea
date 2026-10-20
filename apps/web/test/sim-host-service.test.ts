import { expect, test } from 'bun:test'
import type { LaunchCodeBinding } from '@adea-ai/spatial/sim-bridge'

import { createSimHostService, type SimSessionLookup } from '../src/server/sim-host-service'
import { createSimPrivateAssetReader } from '../src/server/sim-private-assets'

// The approved hosted service, driven against in-memory stores that keep the durable semantics:
// a code is spent by its first presentation and the session is written in the same step.
const ORIGIN = 'https://sim.example'
const PARENT_ORIGIN = 'https://app.example'
const NOW = 1_000
const TOKEN = 'v'.repeat(40)

type Row = {
  code: string
  binding: LaunchCodeBinding
  expiresAt: number
  spent: boolean
  session?: { value: string; expiresAt: number }
}

function memoryStore() {
  const rows = new Map<string, Row>()
  const store = {
    rows,
    seed(code: string, binding: LaunchCodeBinding, expiresAt: number) {
      rows.set(code, { code, binding, expiresAt, spent: false })
    },
    issue() {
      throw new Error('the hosted service never issues codes')
    },
    redeem(code: string, presented: { bridgeId: string; origin: string }, now: number) {
      const row = rows.get(code)
      if (!row) return { ok: false as const, reason: 'unknown' as const }
      if (row.spent) return { ok: false as const, reason: 'code_used' as const }
      row.spent = true
      if (row.expiresAt <= now) return { ok: false as const, reason: 'code_expired' as const }
      if (row.binding.bridgeId !== presented.bridgeId || row.binding.origin !== presented.origin)
        return { ok: false as const, reason: 'origin_refused' as const }
      return { ok: true as const, surface: row.binding.surface }
    },
    redeemAndSave(
      code: string,
      presented: { bridgeId: string; origin: string },
      now: number,
      session: { value: string; expiresAt: number }
    ) {
      const result = store.redeem(code, presented, now)
      if (result.ok) rows.get(code)!.session = session
      return result
    },
  }
  return store
}

type Session = {
  workspaceId: string
  surface: 'hq' | 'room-designer' | 'character-designer'
  expiresAt: number
}

function fixture(
  options: {
    verdict?: 'entitled' | 'not_entitled' | 'unauthenticated' | 'unavailable'
    session?: Session | null
    sessionFailure?: boolean
    location?: string
    entryFiles?: {
      hq: string
      'room-designer': string
      'character-designer': string
    }
  } = {}
) {
  const store = memoryStore()
  const sessions = new Map<string, Session>()
  const reads: { location: string; key: string }[] = []
  const verdict = options.verdict ?? 'entitled'
  const lookup: SimSessionLookup = async (value) => {
    if (options.sessionFailure) throw new Error('the session store is unavailable')
    return sessions.get(value) ?? options.session ?? null
  }
  const reader = createSimPrivateAssetReader({
    location: options.location ?? 'agent-sim-export',
    read: async (request) => {
      reads.push(request)
      return { body: `private:${request.key}`, contentType: 'text/javascript' }
    },
  })
  const host = createSimHostService({
    configuration: {
      origin: ORIGIN,
      parentOrigins: [PARENT_ORIGIN],
      assetPrefix: '/assets/agent-sim/',
      entryFiles: options.entryFiles ?? {
        hq: 'engine.js',
        'room-designer': 'room-designer.js',
        'character-designer': 'character-designer.js',
      },
    },
    store,
    sessions: lookup,
    policy: () => verdict,
    readAsset: (path) => reader(path),
    frameScript: '// bootstrap',
    now: () => NOW,
  })
  const get = (path: string, cookie: string | null = `__Host-adea-sim=${TOKEN}`) =>
    host(new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} }))
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    host(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify(body),
      })
    )
  return { store, sessions, reads, get, post }
}

test('an entitled session reads the private entry and the response is private', async () => {
  const f = fixture()
  f.sessions.set(TOKEN, { workspaceId: 'workspace-one', surface: 'hq', expiresAt: NOW + 60_000 })
  const response = await f.get('/assets/agent-sim/engine.js')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.text()).toBe('private:engine.js')
  expect(f.reads).toEqual([{ location: 'agent-sim-export', key: 'engine.js' }])
})

test('the private read asks for the named location and the key, and the service returns bytes', async () => {
  // This proves the request-side half of the gate: the read names the configured location and the
  // derived key, and the response carries the object rather than an address. Whether the storage
  // location itself is private is a deployment prerequisite, not something this source decides.
  const f = fixture()
  f.sessions.set(TOKEN, { workspaceId: 'workspace-one', surface: 'hq', expiresAt: NOW + 60_000 })
  const response = await f.get('/assets/agent-sim/engine.js')
  expect(response.status).toBe(200)
  expect(f.reads).toEqual([{ location: 'agent-sim-export', key: 'engine.js' }])
  expect(response.headers.get('location')).toBeNull()
  expect(await response.text()).not.toContain('http')
})

test('a request without a session reads nothing', async () => {
  const f = fixture()
  expect((await f.get('/assets/agent-sim/engine.js', null)).status).toBe(401)
  expect((await f.get('/assets/agent-sim/engine.js', '__Host-adea-sim=short')).status).toBe(401)
  expect(f.reads).toEqual([])
})

test('an expired session is refused before any private read', async () => {
  const f = fixture()
  f.sessions.set(TOKEN, { workspaceId: 'workspace-one', surface: 'hq', expiresAt: NOW - 1 })
  expect((await f.get('/assets/agent-sim/engine.js')).status).toBe(401)
  expect(f.reads).toEqual([])
})

test('a session stored for another surface cannot read that surface entry', async () => {
  const f = fixture()
  f.sessions.set(TOKEN, { workspaceId: 'workspace-one', surface: 'hq', expiresAt: NOW + 60_000 })
  expect((await f.get('/assets/agent-sim/room-designer.js')).status).toBe(403)
  expect(f.reads).toEqual([])
})

test('every non-entitled verdict serves no private asset', async () => {
  for (const [verdict, status] of [
    ['not_entitled', 403],
    ['unauthenticated', 401],
    ['unavailable', 503],
  ] as const) {
    const f = fixture({ verdict })
    f.sessions.set(TOKEN, { workspaceId: 'workspace-one', surface: 'hq', expiresAt: NOW + 60_000 })
    const response = await f.get('/assets/agent-sim/engine.js')
    expect(response.status).toBe(status)
    expect(f.reads).toEqual([])
  }
})

test('a session store failure refuses without a private read', async () => {
  const f = fixture({ sessionFailure: true })
  expect((await f.get('/assets/agent-sim/engine.js')).status).toBe(503)
  expect(f.reads).toEqual([])
})

test('a path that escapes the private location is refused', async () => {
  const f = fixture()
  f.sessions.set(TOKEN, { workspaceId: 'workspace-one', surface: 'hq', expiresAt: NOW + 60_000 })
  for (const path of [
    '/assets/agent-sim/shared%2F..%2Fengine.js',
    '/assets/agent-sim/..%2Fescape.js',
  ]) {
    expect((await f.get(path)).status).toBe(404)
  }
  expect(f.reads).toEqual([])
})

test('a renamed surface entry is served and the retired name is not reachable', async () => {
  const f = fixture({
    entryFiles: {
      hq: 'engine-1.js',
      'room-designer': 'room-designer2.js',
      'character-designer': 'character-designer3.js',
    },
  })
  f.sessions.set(TOKEN, { workspaceId: 'workspace-one', surface: 'hq', expiresAt: NOW + 60_000 })
  expect((await f.get('/assets/agent-sim/engine-1.js')).status).toBe(200)
  // The name the host used before the configuration existed is not an ordinary shared asset.
  expect((await f.get('/assets/agent-sim/engine.js')).status).toBe(404)
  expect(f.reads.map((read) => read.key)).toEqual(['engine-1.js'])
})

test('the exchange redeems a code once and the replay gets no session', async () => {
  const f = fixture()
  f.store.seed(
    'c'.repeat(40),
    { bridgeId: 'bridge-identifier-1234', origin: ORIGIN, surface: 'hq' },
    NOW + 60_000
  )
  const request = { schemaVersion: 1, code: 'c'.repeat(40), bridgeId: 'bridge-identifier-1234' }
  const first = await f.post('/session', request)
  expect(first.status).toBe(200)
  const cookie = first.headers.get('set-cookie')
  expect(cookie).toContain('__Host-adea-sim=')
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=None')
  expect(cookie).toContain('Partitioned')
  expect(await first.text()).not.toContain('__Host-adea-sim=')
  expect(f.store.rows.get('c'.repeat(40))?.session).toBeDefined()

  const replay = await f.post('/session', request)
  expect(replay.status).toBe(200)
  expect(replay.headers.get('set-cookie')).toBeNull()
  expect(await replay.json()).toEqual({ status: 'rejected', reason: 'code_used' })
})

test('a code presented from another bridge is refused and no session is minted', async () => {
  const f = fixture()
  f.store.seed(
    'd'.repeat(40),
    { bridgeId: 'bridge-identifier-1234', origin: ORIGIN, surface: 'hq' },
    NOW + 60_000
  )
  const response = await f.post('/session', {
    schemaVersion: 1,
    code: 'd'.repeat(40),
    bridgeId: 'another-bridge-1234',
  })
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(await response.json()).toEqual({ status: 'rejected', reason: 'origin_refused' })
})

test('an unknown code is refused without a session', async () => {
  const f = fixture()
  const response = await f.post('/session', {
    schemaVersion: 1,
    code: 'e'.repeat(40),
    bridgeId: 'bridge-identifier-1234',
  })
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(await response.json()).toEqual({ status: 'rejected', reason: 'code_expired' })
})

test('a cross-origin exchange is refused before the store is consulted', async () => {
  const f = fixture()
  f.store.seed(
    'f'.repeat(40),
    { bridgeId: 'bridge-identifier-1234', origin: ORIGIN, surface: 'hq' },
    NOW + 60_000
  )
  const response = await f.post(
    '/session',
    { schemaVersion: 1, code: 'f'.repeat(40), bridgeId: 'bridge-identifier-1234' },
    { origin: 'https://evil.example' }
  )
  expect(response.status).toBe(403)
  expect(f.store.rows.get('f'.repeat(40))?.spent).toBe(false)
})

test('the frame and configuration routes consult no session and read nothing', async () => {
  const f = fixture()
  for (const path of ['/frame', '/frame.css', '/frame.js', '/configuration']) {
    expect((await f.get(path, null)).status).toBe(200)
  }
  expect(f.reads).toEqual([])
})

test('the service refuses to start from a malformed configuration', () => {
  expect(() =>
    createSimHostService({
      configuration: {
        origin: ORIGIN,
        parentOrigins: [],
        assetPrefix: '/assets/agent-sim/',
        entryFiles: {},
      },
      store: memoryStore() as never,
      sessions: async () => null,
      policy: () => 'entitled',
      readAsset: async () => null,
      frameScript: '// bootstrap',
    })
  ).toThrow()
})

test('a malformed private location name serves no private asset', async () => {
  const f = fixture({ location: 'https://public.example/agent-sim' })
  f.sessions.set(TOKEN, { workspaceId: 'workspace-one', surface: 'hq', expiresAt: NOW + 60_000 })
  expect((await f.get('/assets/agent-sim/engine.js')).status).toBe(404)
  expect(f.reads).toEqual([])
})
