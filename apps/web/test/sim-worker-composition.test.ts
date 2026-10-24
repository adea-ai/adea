import { expect, test } from 'bun:test'

import type { SimHostContract } from '../src/lib/sim-host-contract'
import { createSimHostWorker } from '../src/server/sim-host-worker'
import type { SimR2Object } from '../src/server/sim-r2-store'
import {
  createSimWorkerComposition,
  type SimWorkerEnvironment,
  type SimWorkerStores,
} from '../src/server/sim-worker-composition'

// The composition turns a Worker environment into the service ports. These tests run it through
// the real Worker entry with in-memory stores and a fake bucket: no database, no R2, no network.
const ORIGIN = 'https://sim.example'
const PARENT = 'https://app.example'
const BRIDGE = 'bridge_nonce_123456789'
const CONNECTION = 'postgresql://sim_host:secret@db.invalid/sim'
const NOW = 1_000_000
const CONTRACT: SimHostContract = {
  assetPrefix: '/assets/agent-sim/',
  entryFiles: {
    hq: 'engine.js',
    'room-designer': 'room-designer.js',
    'character-designer': 'character-designer.js',
  },
}

type World = {
  codes: Map<
    string,
    { workspaceId: string; surface: 'hq' | 'room-designer' | 'character-designer' }
  >
  sessions: Map<string, { workspaceId: string; surface: 'hq'; expiresAt: number }>
  granted: Set<string>
  opened: string[]
  closed: number[]
  asked: string[]
  allowlistFails: boolean
}

function world(): World {
  return {
    codes: new Map(),
    sessions: new Map(),
    granted: new Set(),
    opened: [],
    closed: [],
    asked: [],
    allowlistFails: false,
  }
}

function openStores(state: World) {
  return (connectionString: string): SimWorkerStores => {
    state.opened.push(connectionString)
    return {
      store: {
        issue() {
          throw new Error('the hosted service never issues codes')
        },
        redeem: () => ({ ok: false as const, reason: 'unknown' as const }),
        redeemAndSave(code, _presented, _now, session) {
          const row = state.codes.get(code)
          if (!row) return { ok: false as const, reason: 'unknown' as const }
          state.codes.delete(code)
          state.sessions.set(session.value, {
            workspaceId: row.workspaceId,
            surface: 'hq',
            expiresAt: session.expiresAt,
          })
          return { ok: true as const, surface: row.surface }
        },
      },
      sessions: async (value) => state.sessions.get(value) ?? null,
      allowlist: async ({ workspaceId, surface }) => {
        if (state.allowlistFails) throw new Error('allowlist database down')
        return state.granted.has(`${workspaceId}:${surface}`)
      },
      close: () => {
        state.closed.push(state.closed.length + 1)
      },
    }
  }
}

function environment(state: World, override: Partial<SimWorkerEnvironment> = {}) {
  const objects: Record<string, SimR2Object> = {
    'engine.js': { body: new Response('engine').body, httpMetadata: {} },
    'packages/characters/assets/x.txt': { body: new Response('withheld').body },
  }
  const bucket = {
    async get(key: string) {
      state.asked.push(key)
      return objects[key] ?? null
    },
  }
  return {
    SIM_DATABASE: { connectionString: CONNECTION },
    SIM_EXPORT: bucket,
    SIM_ORIGIN: ORIGIN,
    SIM_PARENT_ORIGINS: PARENT,
    ...override,
  } satisfies SimWorkerEnvironment
}

function worker(state: World, frameScript = '// public bootstrap') {
  return createSimHostWorker<SimWorkerEnvironment>(
    createSimWorkerComposition({
      contract: CONTRACT,
      frameScript,
      openStores: openStores(state),
      now: () => NOW,
    })
  )
}

async function launch(
  instance: ReturnType<typeof worker>,
  env: SimWorkerEnvironment,
  state: World,
  workspaceId = 'workspace-one'
) {
  // The launch contract wants a long opaque code.
  const code = `code-${state.codes.size}-`.padEnd(40, 'x')
  state.codes.set(code, { workspaceId, surface: 'hq' })
  const response = await instance.fetch(
    new Request(`${ORIGIN}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ schemaVersion: 1, code, bridgeId: BRIDGE }),
    }),
    env
  )
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  return { response, cookie }
}

const asset = (cookie: string, path = 'engine.js') =>
  new Request(`${ORIGIN}/assets/agent-sim/${path}`, { headers: { cookie } })

test('a granted workspace redeems a code and reads the engine through the bucket', async () => {
  const state = world()
  state.granted.add('workspace-one:hq')
  const env = environment(state)
  const instance = worker(state)
  const { cookie } = await launch(instance, env, state)
  expect(cookie).toBeTruthy()

  const response = await instance.fetch(asset(cookie!), env)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('engine')
  expect(response.headers.get('content-type')).toBe('text/javascript')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(state.asked).toEqual(['engine.js'])
})

test('a workspace with no grant is refused and the bucket is never asked', async () => {
  const state = world()
  const env = environment(state)
  const instance = worker(state)
  const { cookie } = await launch(instance, env, state)
  expect(cookie).toBeTruthy()
  const response = await instance.fetch(asset(cookie!), env)
  expect(response.status).toBe(403)
  expect(state.asked).toEqual([])
})

test('a failing allowlist serves nothing and never reads the bucket', async () => {
  const state = world()
  state.granted.add('workspace-one:hq')
  const env = environment(state)
  const instance = worker(state)
  const { cookie } = await launch(instance, env, state)
  state.allowlistFails = true
  const response = await instance.fetch(asset(cookie!), env)
  expect(response.status).toBeGreaterThanOrEqual(500)
  expect(state.asked).toEqual([])
  state.allowlistFails = false
  expect((await instance.fetch(asset(cookie!), env)).status).toBe(200)
})

test('a withheld third-party pack is never read, even for a granted workspace', async () => {
  const state = world()
  state.granted.add('workspace-one:hq')
  const env = environment(state)
  const instance = worker(state)
  const { cookie } = await launch(instance, env, state)
  const response = await instance.fetch(asset(cookie!, 'packages/characters/assets/x.txt'), env)
  expect(response.status).toBe(404)
  expect(state.asked).toEqual([])
})

test('the stores are opened per request with the database string, and closed after each answer', async () => {
  const state = world()
  state.granted.add('workspace-one:hq')
  const env = environment(state)
  const instance = worker(state)
  const { cookie } = await launch(instance, env, state)
  await instance.fetch(asset(cookie!), env)
  await instance.fetch(new Request(`${ORIGIN}/frame`), env)
  expect(state.opened).toEqual([CONNECTION, CONNECTION, CONNECTION])
  expect(state.closed).toEqual([1, 2, 3])
})

test('the frame route serves the supplied public bootstrap and nothing private', async () => {
  const state = world()
  const env = environment(state)
  const response = await worker(state, '// the bootstrap bundle').fetch(
    new Request(`${ORIGIN}/frame`),
    env
  )
  expect(response.status).toBeLessThan(500)
  expect(state.asked).toEqual([])
})

const BROKEN: Record<string, (state: World) => Partial<SimWorkerEnvironment>> = {
  'no database binding': () => ({ SIM_DATABASE: undefined }),
  'a null database binding': () => ({ SIM_DATABASE: null }),
  'an empty connection string': () => ({ SIM_DATABASE: { connectionString: '' } }),
  'a blank connection string': () => ({ SIM_DATABASE: { connectionString: '   ' } }),
  'a non-string connection string': () => ({ SIM_DATABASE: { connectionString: 7 } }),
  'no bucket binding': () => ({ SIM_EXPORT: undefined }),
  'a bucket without get': () => ({ SIM_EXPORT: {} as never }),
  'no origin': () => ({ SIM_ORIGIN: undefined }),
  'a blank origin': () => ({ SIM_ORIGIN: '  ' }),
  'no parent origins': () => ({ SIM_PARENT_ORIGINS: undefined }),
  'an empty parent origin in the list': () => ({ SIM_PARENT_ORIGINS: `${PARENT},` }),
  'a malformed location': () => ({ SIM_EXPORT_LOCATION: 'https://bucket.example/path' }),
  'a non-string location': () => ({ SIM_EXPORT_LOCATION: 3 }),
  'a parent origin equal to the frame origin': () => ({ SIM_PARENT_ORIGINS: ORIGIN }),
  'a plain http frame origin': () => ({ SIM_ORIGIN: 'http://sim.example' }),
  'a loopback http frame origin': () => ({
    SIM_ORIGIN: 'http://127.0.0.1:8799',
    SIM_PARENT_ORIGINS: 'http://localhost:3000',
  }),
}

for (const [name, change] of Object.entries(BROKEN)) {
  test(`${name} answers not configured and opens no store`, async () => {
    const state = world()
    const env = { ...environment(state), ...change(state) }
    const response = await worker(state).fetch(new Request(`${ORIGIN}/frame`), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'not_configured' })
    expect(state.opened).toEqual([])
    expect(state.asked).toEqual([])
  })
}

test('an environment that is not an object answers not configured', async () => {
  const state = world()
  const instance = worker(state)
  for (const env of [null, undefined, 'text']) {
    const response = await instance.fetch(new Request(`${ORIGIN}/frame`), env as never)
    expect(response.status).toBe(503)
  }
  expect(state.opened).toEqual([])
})

test('a store that cannot be opened answers not configured without leaking the reason', async () => {
  const state = world()
  const instance = createSimHostWorker<SimWorkerEnvironment>(
    createSimWorkerComposition({
      contract: CONTRACT,
      frameScript: '// bootstrap',
      openStores: () => {
        throw new Error('postgresql://sim_host:secret@db.invalid refused')
      },
    })
  )
  const response = await instance.fetch(new Request(`${ORIGIN}/frame`), environment(state))
  expect(response.status).toBe(503)
  expect(JSON.stringify(await response.json())).not.toContain('secret')
})

test('a non-default location name is used and the default is a plain name', async () => {
  const state = world()
  state.granted.add('workspace-one:hq')
  const env = environment(state, { SIM_EXPORT_LOCATION: 'rehearsal-export' })
  const instance = worker(state)
  const { cookie } = await launch(instance, env, state)
  expect((await instance.fetch(asset(cookie!), env)).status).toBe(200)
})

test('the factory refuses an unusable contract, frame script or store opener at startup', () => {
  const base = { contract: CONTRACT, frameScript: '// bootstrap', openStores: openStores(world()) }
  expect(() => createSimWorkerComposition(base)).not.toThrow()
  expect(() => createSimWorkerComposition({ ...base, contract: undefined as never })).toThrow(
    'contract'
  )
  expect(() =>
    createSimWorkerComposition({
      ...base,
      contract: { ...CONTRACT, assetPrefix: 'assets/agent-sim' },
    })
  ).toThrow('contract')
  expect(() =>
    createSimWorkerComposition({
      ...base,
      contract: {
        ...CONTRACT,
        entryFiles: { ...CONTRACT.entryFiles, 'room-designer': 'engine.js' },
      },
    })
  ).toThrow('contract')
  expect(() => createSimWorkerComposition({ ...base, frameScript: '' })).toThrow('frame script')
  expect(() => createSimWorkerComposition({ ...base, frameScript: 5 as never })).toThrow(
    'frame script'
  )
  expect(() => createSimWorkerComposition({ ...base, openStores: undefined as never })).toThrow(
    'stores'
  )
})
