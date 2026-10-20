import { expect, test } from 'bun:test'
import { createSimHost } from '../src/server/sim-host'

// Characterisation of the per-request fan-out in createSimHost: how many session lookups, entitlement
// evaluations and private reads each request costs, and where a request stops. The fakes are in memory.
const origin = 'https://sim.example'
const parentOrigin = 'https://app.example'
const token = 'v'.repeat(40)
const now = 1_000

type Verdict = 'entitled' | 'not_entitled' | 'unauthenticated' | 'unavailable'
type Counts = { session: number; entitlement: number; read: number }

function fixture(verdict: Verdict = 'entitled') {
  const counts: Counts = { session: 0, entitlement: 0, read: 0 }
  const reads: string[] = []
  const host = createSimHost({
    origin,
    parentOrigins: [parentOrigin],
    assetPrefix: '/assets/agent-sim/',
    entryFiles: {
      hq: 'engine.js',
      'room-designer': 'room-designer.js',
      'character-designer': 'character-designer.js',
    },
    frameScript: '// bootstrap',
    exchange: async () => {
      throw new Error('the exchange is not used by this test')
    },
    session: async (value) => {
      counts.session++
      return value === token
        ? { workspaceId: 'workspace-one', surface: 'hq', expiresAt: now + 60_000 }
        : null
    },
    entitlement: async () => {
      counts.entitlement++
      return verdict
    },
    now: () => now,
    readAsset: async (path) => {
      counts.read++
      reads.push(path)
      return { body: 'private-fixture', contentType: 'text/javascript' }
    },
  })
  const get = (path: string, cookie: string | null = `__Host-adea-sim=${token}`) =>
    host(new Request(`${origin}${path}`, { headers: cookie ? { cookie } : {} }))
  return { counts, reads, get }
}

test('each authorised private read costs one session lookup, one entitlement evaluation and one read', async () => {
  const f = fixture()
  const paths = ['engine.js', 'shared/fonts/sans.woff2', 'shared/audio/loop.ogg']
  for (const path of paths) {
    const before = { ...f.counts }
    const response = await f.get(`/assets/agent-sim/${path}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(f.counts).toEqual({
      session: before.session + 1,
      entitlement: before.entitlement + 1,
      read: before.read + 1,
    })
  }
  expect(f.reads).toEqual(paths)
})

test('the frame and configuration routes consult no session, entitlement or reader', async () => {
  const f = fixture()
  for (const path of ['/frame', '/frame.css', '/frame.js', '/configuration']) {
    expect((await f.get(path, null)).status).toBe(200)
  }
  expect(f.counts).toEqual({ session: 0, entitlement: 0, read: 0 })
})

test('requests refused before the entitlement boundary cost no entitlement evaluation and no read', async () => {
  // A missing or malformed cookie is refused before any session lookup.
  const none = fixture()
  expect((await none.get('/assets/agent-sim/engine.js', null)).status).toBe(401)
  expect((await none.get('/assets/agent-sim/engine.js', '__Host-adea-sim=short')).status).toBe(401)
  expect(none.counts).toEqual({ session: 0, entitlement: 0, read: 0 })

  // An unknown session, a path that escapes the prefix and another surface's entry each cost one lookup.
  const refused = fixture()
  const unknown = `__Host-adea-sim=${'w'.repeat(40)}`
  expect((await refused.get('/assets/agent-sim/engine.js', unknown)).status).toBe(401)
  expect((await refused.get('/assets/agent-sim/shared%2F..%2Fengine.js')).status).toBe(404)
  expect((await refused.get('/assets/agent-sim/room-designer.js')).status).toBe(403)
  expect(refused.counts).toEqual({ session: 3, entitlement: 0, read: 0 })
  expect(refused.reads).toEqual([])
})

test('every non-entitled verdict costs one session lookup and one entitlement evaluation, and reads nothing', async () => {
  const cases: [Verdict, number][] = [
    ['not_entitled', 403],
    ['unauthenticated', 401],
    ['unavailable', 503],
  ]
  for (const [verdict, status] of cases) {
    const f = fixture(verdict)
    const response = await f.get('/assets/agent-sim/engine.js')
    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(f.counts).toEqual({ session: 1, entitlement: 1, read: 0 })
  }
})
