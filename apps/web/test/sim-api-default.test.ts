import { afterEach, expect, test } from 'bun:test'
import { simConfiguration, simLaunch } from '../src/server/sim-api'

// The production composition reads ADEA_SIM_ORIGIN and supplies no issuer. These tests pin that a configured
// hostname alone grants nothing, and that the production default stays closed.
const app = 'https://app.example.test'
const savedOrigin = process.env.ADEA_SIM_ORIGIN
const body = {
  schemaVersion: 1,
  workspaceId: 'workspace-one',
  surface: 'hq',
  platform: 'desktop',
  bridgeId: 'bridge_nonce_123456789',
}
const launch = (value: unknown, origin = app) =>
  new Request(`${app}/api/sim/launch`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
const configuration = () => simConfiguration(new Request(`${app}/api/sim/config`))

afterEach(() => {
  if (savedOrigin === undefined) delete process.env.ADEA_SIM_ORIGIN
  else process.env.ADEA_SIM_ORIGIN = savedOrigin
})

test('without ADEA_SIM_ORIGIN the production launch is not configured and issues no grant', async () => {
  delete process.env.ADEA_SIM_ORIGIN
  expect(await (await configuration()).json()).toEqual({
    frameOrigin: null,
    allowLoopbackHttp: false,
  })
  const response = await simLaunch(launch(body))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'unavailable', reason: 'not_configured' })
})

test('a configured sim origin alone still issues nothing', async () => {
  process.env.ADEA_SIM_ORIGIN = 'https://sim.example.test'
  expect(await (await configuration()).json()).toEqual({
    frameOrigin: 'https://sim.example.test',
    allowLoopbackHttp: false,
  })
  const response = await simLaunch(launch(body))
  expect(await response.json()).toEqual({ status: 'unavailable', reason: 'not_configured' })
})

test('an insecure sim origin is not configured, and a foreign caller is refused before anything else', async () => {
  process.env.ADEA_SIM_ORIGIN = 'http://sim.example.test'
  expect(await (await configuration()).json()).toEqual({
    frameOrigin: null,
    allowLoopbackHttp: false,
  })
  const foreign = await simLaunch(launch(body, 'https://foreign.example.test'))
  expect(foreign.status).toBe(403)
  expect(await foreign.json()).toEqual({ status: 'denied', reason: 'unauthenticated' })
})

test('a malformed launch body is rejected as invalid, not answered as configured', async () => {
  process.env.ADEA_SIM_ORIGIN = 'https://sim.example.test'
  const response = await simLaunch(launch({ ...body, surface: 'lobby' }))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ status: 'invalid_request' })
})
