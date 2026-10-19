import { expect, test } from 'bun:test'
import type { SimEntitlementVerdict } from '@adea-ai/spatial/sim-bridge'
import { createSimHost, type SimAssetContext, type SimTrustedSession } from '../src/server/sim-host'

// Fakes only: the session store, entitlement and private storage are all in-memory functions here.
type Options = Parameters<typeof createSimHost>[0]

const origin = 'https://sim.example'
const parent = 'https://app.example'
const token = 'v'.repeat(40)
const cookie = `__Host-adea-sim=${token}`
const now = 1_000
const entryFiles = {
  hq: 'engine.js',
  'room-designer': 'room-designer.js',
  'character-designer': 'character-designer.js',
}
const live: SimTrustedSession = {
  workspaceId: 'workspace-one',
  surface: 'hq',
  expiresAt: now + 60_000,
}

function build(overrides: Partial<Pick<Options, 'session' | 'entitlement' | 'now'>> = {}) {
  const reads: Array<{ path: string; context: SimAssetContext }> = []
  const checks: SimAssetContext[] = []
  const host = createSimHost({
    origin,
    parentOrigins: [parent],
    assetPrefix: '/assets/agent-sim/',
    entryFiles,
    frameScript: '// bootstrap',
    exchange: (async () => ({ body: { status: 'unavailable' } })) as never,
    session: async (value) => (value === token ? live : null),
    entitlement: async (context) => {
      checks.push(context)
      return context.workspaceId === 'workspace-one' ? 'entitled' : 'not_entitled'
    },
    now: () => now,
    readAsset: async (path, context) => {
      reads.push({ path, context })
      return { body: `asset:${path}`, contentType: 'text/javascript' }
    },
    ...overrides,
  })
  const get = (path: string, headers: Record<string, string> = {}) =>
    host(new Request(`${origin}${path}`, { headers: { cookie, ...headers } }))
  return { get, host, reads, checks }
}

test('the workspace comes from the stored session row, and a client workspace hint is ignored', async () => {
  const f = build()
  expect((await f.get('/assets/agent-sim/engine.js?workspaceId=workspace-two')).status).toBe(200)
  expect(
    (
      await f.get('/assets/agent-sim/engine.js', {
        'x-workspace-id': 'workspace-two',
        'x-adea-workspace-id': 'workspace-two',
      })
    ).status
  ).toBe(200)
  expect(f.reads.map((read) => read.context.workspaceId)).toEqual([
    'workspace-one',
    'workspace-one',
  ])
  expect(f.checks.every((context) => context.workspaceId === 'workspace-one')).toBe(true)
})

test('a workspace hint cannot reach a workspace the stored session is not entitled to', async () => {
  const f = build({
    session: async () => ({ ...live, workspaceId: 'workspace-two' }),
  })
  expect((await f.get('/assets/agent-sim/engine.js?workspaceId=workspace-one')).status).toBe(403)
  expect(f.checks.map((context) => context.workspaceId)).toEqual(['workspace-two'])
  expect(f.reads).toEqual([])
})

test('a surface other than the stored one is refused, and a surface hint cannot change it', async () => {
  const f = build({
    session: async () => ({ ...live, surface: 'room-designer' }),
  })
  expect((await f.get('/assets/agent-sim/engine.js?surface=hq')).status).toBe(403)
  expect((await f.get('/assets/agent-sim/character-designer.js')).status).toBe(403)
  expect(f.reads).toEqual([])
  expect(f.checks).toEqual([])
  expect((await f.get('/assets/agent-sim/room-designer.js')).status).toBe(200)
  expect(f.reads).toEqual([
    {
      path: 'room-designer.js',
      context: { workspaceId: 'workspace-one', surface: 'room-designer' },
    },
  ])
})

test('unknown, revoked, expired and malformed sessions are refused before any read', async () => {
  // A revoked session is excluded by the store, so the gate sees the same null as an unknown one.
  const unknown = build({ session: async () => null })
  expect((await unknown.get('/assets/agent-sim/engine.js')).status).toBe(401)
  const expired = build({ session: async () => ({ ...live, expiresAt: now }) })
  expect((await expired.get('/assets/agent-sim/engine.js')).status).toBe(401)
  const blank = build({ session: async () => ({ ...live, workspaceId: '' }) })
  expect((await blank.get('/assets/agent-sim/engine.js')).status).toBe(401)
  const malformed = build()
  expect(
    (
      await malformed.host(
        new Request(`${origin}/assets/agent-sim/engine.js`, {
          headers: { cookie: '__Host-adea-sim=short' },
        })
      )
    ).status
  ).toBe(401)
  expect((await malformed.host(new Request(`${origin}/assets/agent-sim/engine.js`))).status).toBe(
    401
  )
  for (const f of [unknown, expired, blank, malformed]) {
    expect(f.reads).toEqual([])
    expect(f.checks).toEqual([])
  }
})

test('a non-finite clock refuses before the session or any read', async () => {
  const f = build({ now: () => Number.NaN })
  expect((await f.get('/assets/agent-sim/engine.js')).status).toBe(401)
  expect(f.reads).toEqual([])
  expect(f.checks).toEqual([])
})

test('an unavailable session store refuses without a private read', async () => {
  const f = build({
    session: async () => {
      throw new Error('store down')
    },
  })
  expect((await f.get('/assets/agent-sim/engine.js')).status).toBe(503)
  expect(f.reads).toEqual([])
  expect(f.checks).toEqual([])
})

test('only an entitled verdict serves a private asset; every other outcome refuses without a read', async () => {
  const cases: Array<[string, () => Promise<SimEntitlementVerdict>, number]> = [
    ['not_entitled', async () => 'not_entitled', 403],
    ['unauthenticated', async () => 'unauthenticated', 401],
    ['unavailable', async () => 'unavailable', 503],
    [
      'a throwing entitlement',
      async () => {
        throw new Error('entitlement down')
      },
      503,
    ],
  ]
  for (const [name, entitlement, status] of cases) {
    const f = build({ entitlement })
    expect({ name, status: (await f.get('/assets/agent-sim/engine.js')).status }).toEqual({
      name,
      status,
    })
    expect(f.reads).toEqual([])
  }
  const entitled = build({ entitlement: async () => 'entitled' })
  expect((await entitled.get('/assets/agent-sim/engine.js')).status).toBe(200)
  expect(entitled.reads).toEqual([
    { path: 'engine.js', context: { workspaceId: 'workspace-one', surface: 'hq' } },
  ])
})

test('the host refuses to start without an explicit entitlement boundary', () => {
  expect(() =>
    createSimHost({
      origin,
      parentOrigins: [parent],
      assetPrefix: '/assets/agent-sim/',
      entryFiles,
      frameScript: '// bootstrap',
      exchange: (async () => ({ body: { status: 'unavailable' } })) as never,
      session: async () => null,
      readAsset: async () => null,
    } as unknown as Options)
  ).toThrow('entitlement boundary')
})
