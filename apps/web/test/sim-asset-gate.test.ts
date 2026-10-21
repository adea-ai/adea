import { describe, expect, test } from 'bun:test'
import type { SimEntitlementVerdict } from '@adea-ai/spatial/sim-bridge'
import { createSimHost, type SimAssetContext, type SimTrustedSession } from '../src/server/sim-host'
import { createSimPrivateAssetReader } from '../src/server/sim-private-assets'
import { createSyntheticPrivateStore } from './fixtures/sim-private-assets/synthetic-store'

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

test('a session that expires while entitlement is pending is refused before any private read', async () => {
  let clock = now
  const f = build({
    now: () => clock,
    entitlement: async (): Promise<SimEntitlementVerdict> => {
      // The entitlement answer arrives after the session has expired.
      clock = live.expiresAt
      return 'entitled'
    },
  })
  expect((await f.get('/assets/agent-sim/engine.js')).status).toBe(401)
  expect(f.reads).toEqual([])

  clock = now
  const broken = build({
    now: () => clock,
    entitlement: async (): Promise<SimEntitlementVerdict> => {
      clock = Number.NaN
      return 'entitled'
    },
  })
  expect((await broken.get('/assets/agent-sim/engine.js')).status).toBe(401)
  expect(broken.reads).toEqual([])
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
  const entitled = build({ entitlement: async (): Promise<SimEntitlementVerdict> => 'entitled' })
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

// The private-asset gate as the approved composition wires it: the real host, the real reader and
// a synthetic store. Nothing here reaches a storage provider, a bucket, a credential or a
// deployment; what is proven is the request-side contract of the gate.
describe('the private-asset gate as the approved composition wires it', () => {
  const object = { body: 'private-bytes', contentType: 'text/javascript' }

  function composed(
    options: {
      objects?: Record<string, { body: string; contentType: string }>
      answer?: (request: { location: string; key: string }) => unknown
      verdict?: SimEntitlementVerdict
    } = {}
  ) {
    const store = createSyntheticPrivateStore({
      objects: options.objects ?? { 'engine.js': object },
      answer: options.answer as never,
    })
    const checks: SimAssetContext[] = []
    const reader = createSimPrivateAssetReader({ location: 'agent-sim-export', read: store.read })
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
        return options.verdict ?? 'entitled'
      },
      now: () => now,
      readAsset: async (path) => await reader(path),
    })
    const get = (path: string, headers: Record<string, string> = {}) =>
      host(new Request(`${origin}${path}`, { headers: { cookie, ...headers } }))
    return { get, host, store, checks }
  }

  test('a path that is encoded once is refused before the storage is read', async () => {
    // The host decodes the request path once and refuses the dot and empty segments that decoding
    // exposes, so the storage is never asked for a key that could leave the location.
    for (const path of [
      '/assets/agent-sim/%2e%2e%2fescape.js',
      '/assets/agent-sim/%2e%2e/escape.js',
      '/assets/agent-sim/..%2fescape.js',
      '/assets/agent-sim/%2Fetc%2Fpasswd',
      '/assets/agent-sim/engine%00.js',
      '/assets/agent-sim/engine%5Cfont.woff2',
      '/assets/agent-sim//engine.js',
    ]) {
      const f = composed()
      const response = await f.get(path)
      expect({ path, status: response.status }).toEqual({ path, status: 404 })
      expect(f.store.calls).toBe(0)
    }
  })

  test('a path that is encoded twice is refused the same way', async () => {
    // The host decodes the request path once, so a path that was encoded twice arrives at the
    // reader still encoded. The reader refuses it as well, so the storage is not asked for a key
    // that a storage adapter would decode into a path.
    for (const path of [
      '/assets/agent-sim/%252e%252e%252fescape.js',
      '/assets/agent-sim/%252fetc%252fpasswd',
    ]) {
      const f = composed()
      const response = await f.get(path)
      expect({ path, status: response.status }).toEqual({ path, status: 404 })
      expect(f.store.calls).toBe(0)
    }
  })

  test('an entitled session reads the asset exactly once, from the named location', async () => {
    const f = composed()
    const response = await f.get('/assets/agent-sim/engine.js')
    expect(response.status).toBe(200)
    expect(f.store.calls).toBe(1)
    expect(f.store.requests).toEqual([{ location: 'agent-sim-export', key: 'engine.js' }])
    expect(f.checks).toEqual([{ workspaceId: 'workspace-one', surface: 'hq' }])
  })

  test('an absent object is a 404, and the storage was asked once', async () => {
    const f = composed({ objects: {} })
    const response = await f.get('/assets/agent-sim/engine.js')
    expect(response.status).toBe(404)
    expect(f.store.calls).toBe(1)
  })

  test('a storage that fails serves no asset, and the failure is not an empty success', async () => {
    const failing = composed({
      answer: () => {
        throw new Error('storage down')
      },
    })
    const failed = await failing.get('/assets/agent-sim/engine.js')
    expect(failed.status).toBe(503)
    expect(await failed.text()).toBe('')

    // A storage that answers with something that is not an object is a fault as well, not an
    // empty asset that looks like a success.
    const malformed = composed({ answer: () => 'not an asset' })
    const broken = await malformed.get('/assets/agent-sim/engine.js')
    expect(broken.status).toBe(503)
    expect(await broken.text()).toBe('')
  })

  test('a private answer never becomes a redirect and never carries an address', async () => {
    const f = composed({
      answer: () => ({
        body: 'private-bytes',
        contentType: 'text/javascript',
        location: 'https://public.example/agent-sim/engine.js',
        url: 'https://public.example/agent-sim/engine.js?signature=secret',
      }),
    })
    const response = await f.get('/assets/agent-sim/engine.js')
    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toBe('private-bytes')
    expect(JSON.stringify([...response.headers])).not.toContain('public.example')
  })

  test('every private answer is private and is not stored anywhere', async () => {
    const f = composed()
    const response = await f.get('/assets/agent-sim/engine.js')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    // The refusals are just as uncached as the asset itself.
    for (const path of ['/assets/agent-sim/engine.js', '/assets/agent-sim/%2e%2e%2fescape.js']) {
      const refused = await f.get(path)
      expect(refused.headers.get('cache-control')).toBe('private, no-store')
    }
  })

  test('a session cannot read what another session may read', async () => {
    const store = createSyntheticPrivateStore({ objects: { 'engine.js': object } })
    const reader = createSimPrivateAssetReader({ location: 'agent-sim-export', read: store.read })
    const other = 'w'.repeat(40)
    const host = createSimHost({
      origin,
      parentOrigins: [parent],
      assetPrefix: '/assets/agent-sim/',
      entryFiles,
      frameScript: '// bootstrap',
      exchange: (async () => ({ body: { status: 'unavailable' } })) as never,
      session: async (value) =>
        value === token ? live : value === other ? { ...live, workspaceId: 'workspace-two' } : null,
      entitlement: async (context) =>
        context.workspaceId === 'workspace-one' ? 'entitled' : 'not_entitled',
      now: () => now,
      readAsset: async (path) => await reader(path),
    })
    const first = await host(
      new Request(`${origin}/assets/agent-sim/engine.js`, {
        headers: { cookie: `__Host-adea-sim=${token}` },
      })
    )
    const second = await host(
      new Request(`${origin}/assets/agent-sim/engine.js`, {
        headers: { cookie: `__Host-adea-sim=${other}` },
      })
    )
    expect(first.status).toBe(200)
    expect(second.status).toBe(403)
    // The workspace that may not read never reached the storage.
    expect(store.calls).toBe(1)
    // Two requests are two reads: the host keeps no copy of an asset between them.
    const again = await host(
      new Request(`${origin}/assets/agent-sim/engine.js`, {
        headers: { cookie: `__Host-adea-sim=${token}` },
      })
    )
    expect(again.status).toBe(200)
    expect(store.calls).toBe(2)
  })
})
