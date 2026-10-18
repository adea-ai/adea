import { expect, test } from 'bun:test'
import {
  createLaunchCodeLedger,
  createSimLaunchIssuer,
  createSimSessionExchange,
  type SimSessionRecord,
} from '../../../packages/spatial/src/sim-bridge'
import { createSimApi } from '../src/server/sim-http'
import { createSimHost } from '../src/server/sim-host'

const parentOrigin = 'https://app.example'
const origin = 'https://sim.example'
const body = {
  schemaVersion: 1,
  workspaceId: 'workspace-one',
  surface: 'hq',
  platform: 'desktop',
  bridgeId: 'bridge_nonce_123456789',
}
const post = (url: string, value: unknown, source = parentOrigin) =>
  new Request(url, {
    method: 'POST',
    headers: { origin: source, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })

function fixture() {
  let now = Date.now()
  const store = createLaunchCodeLedger()
  const sessions = new Map<string, SimSessionRecord>()
  const issuer = createSimLaunchIssuer({
    frameOrigin: origin,
    store,
    entitlement: async (query) =>
      query.workspaceId === 'workspace-one' ? 'entitled' : 'not_entitled',
    now: () => now,
  })
  const exchange = createSimSessionExchange({
    origin,
    store,
    sessions: {
      save(value, record) {
        sessions.set(value, record)
      },
    },
    now: () => now,
  })
  let assetReads = 0
  const api = createSimApi({
    frameOrigin: origin,
    trustedHostOrigins: [parentOrigin],
    issue: async (_, value) => issuer(value),
  })
  const host = createSimHost({
    origin,
    parentOrigins: [parentOrigin],
    frameScript: '// public bootstrap only',
    exchange,
    session: async (value) => sessions.get(value) ?? null,
    now: () => now,
    readAsset: async (path) => {
      assetReads++
      return path === 'engine.js'
        ? { body: 'private-engine-fixture', contentType: 'text/javascript' }
        : null
    },
  })
  return {
    api,
    host,
    advance: () => {
      now += 3600_001
    },
    assetReads: () => assetReads,
    invalidateClock: () => {
      now = Number.NaN
    },
  }
}

test('only the isolated Sim policy adds blob connections while every other directive stays fixed', async () => {
  const f = fixture()
  const frame = await f.host(new Request(`${origin}/frame`))
  expect(frame.headers.get('content-security-policy')).toBe(
    `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob:; worker-src 'self' blob:; frame-ancestors ${parentOrigin}`
  )
  expect(f.api.configuration().headers.get('content-security-policy')).toBeNull()
  expect((await f.host(new Request(`${origin}/assets/agent-sim/engine.js`))).status).toBe(401)
  expect(f.assetReads()).toBe(0)
})

test('launch, single-use exchange and authenticated private delivery are joined across the HTTP boundary', async () => {
  const f = fixture()
  const anonymous = await f.host(new Request(`${origin}/assets/agent-sim/engine.js`))
  expect(anonymous.status).toBe(401)
  expect(f.assetReads()).toBe(0)
  const grant = (await (
    await f.api.launch(post(`${parentOrigin}/api/sim/launch`, body))
  ).json()) as { code: string }
  const exchanged = await f.host(
    post(
      `${origin}/session`,
      { schemaVersion: 1, code: grant.code, bridgeId: body.bridgeId },
      origin
    )
  )
  expect(await exchanged.json()).toMatchObject({ status: 'session' })
  const setCookie = exchanged.headers.get('set-cookie')!
  expect(setCookie).toContain('HttpOnly')
  expect(setCookie).toContain('Secure')
  expect(setCookie).toContain('Partitioned')
  const cookie = setCookie.split(';')[0]!
  const asset = await f.host(
    new Request(`${origin}/assets/agent-sim/engine.js`, { headers: { cookie } })
  )
  expect(await asset.text()).toBe('private-engine-fixture')
  expect(asset.headers.get('cache-control')).toBe('private, no-store')
  const replay = await f.host(
    post(
      `${origin}/session`,
      { schemaVersion: 1, code: grant.code, bridgeId: body.bridgeId },
      origin
    )
  )
  expect(await replay.json()).toMatchObject({ status: 'rejected' })
  expect(
    (
      await f.host(
        new Request(`${origin}/assets/agent-sim/room-designer.js`, { headers: { cookie } })
      )
    ).status
  ).toBe(403)
  f.advance()
  expect(
    (await f.host(new Request(`${origin}/assets/agent-sim/engine.js`, { headers: { cookie } })))
      .status
  ).toBe(401)
  expect(f.assetReads()).toBe(1)
})

test('foreign host, forged desktop hint and missing authority cannot grant a launch', async () => {
  const f = fixture()
  expect(
    (await f.api.launch(post(`${parentOrigin}/api/sim/launch`, body, 'https://foreign.example')))
      .status
  ).toBe(403)
  expect(
    await (
      await f.api.launch(
        post(`${parentOrigin}/api/sim/launch`, { ...body, workspaceId: 'foreign-workspace' })
      )
    ).json()
  ).toEqual({ status: 'denied', reason: 'not_entitled' })
  const closed = createSimApi({ frameOrigin: origin, trustedHostOrigins: [parentOrigin] })
  expect(await (await closed.launch(post(`${parentOrigin}/api/sim/launch`, body))).json()).toEqual({
    status: 'unavailable',
    reason: 'not_configured',
  })
})

test('session exchange refuses cross-origin POST and malformed or oversized bodies', async () => {
  const f = fixture()
  expect((await f.host(post(`${origin}/session`, {}, parentOrigin))).status).toBe(403)
  expect(
    (await f.api.launch(post(`${parentOrigin}/api/sim/launch`, { extra: 'x'.repeat(5000) }))).status
  ).toBe(400)
  expect(
    (
      await f.api.launch(
        new Request(`${parentOrigin}/api/sim/launch`, {
          method: 'POST',
          headers: { origin: parentOrigin },
          body: '{}',
        })
      )
    ).status
  ).toBe(400)
})

test('private asset gate refuses a non-finite clock before reading private storage', async () => {
  const f = fixture()
  const grant = (await (
    await f.api.launch(post(`${parentOrigin}/api/sim/launch`, body))
  ).json()) as { code: string }
  const exchanged = await f.host(
    post(
      `${origin}/session`,
      { schemaVersion: 1, code: grant.code, bridgeId: body.bridgeId },
      origin
    )
  )
  const cookie = exchanged.headers.get('set-cookie')!.split(';')[0]!
  f.invalidateClock()
  expect(
    (await f.host(new Request(`${origin}/assets/agent-sim/engine.js`, { headers: { cookie } })))
      .status
  ).toBe(401)
  expect(f.assetReads()).toBe(0)
})
