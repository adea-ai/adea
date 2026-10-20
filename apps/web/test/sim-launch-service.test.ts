import { expect, test } from 'bun:test'
import type { LaunchCodeBinding } from '@adea-ai/spatial/sim-bridge'

import { createSimLaunchService } from '../src/server/sim-launch-service'

// The approved launch composition, driven against an in-memory store that keeps the durable
// semantics: a code is spent by its first presentation, whether or not that presentation matched
// its binding, and the session is written in the same step as the spend.
type Row = {
  code: string
  workspaceId: string
  binding: LaunchCodeBinding
  expiresAt: number
  spent: boolean
  session?: { value: string; expiresAt: number }
}

function memoryStore() {
  const rows = new Map<string, Row>()
  const store = {
    rows,
    issue(code: string, binding: LaunchCodeBinding, workspaceId: string, expiresAt: number) {
      rows.set(code, { code, workspaceId, binding, expiresAt, spent: false })
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
  const createStore = (workspaceId: string) => ({
    issue: (code: string, binding: LaunchCodeBinding, expiresAt: number) =>
      store.issue(code, binding, workspaceId, expiresAt),
    redeem: store.redeem,
    redeemAndSave: store.redeemAndSave,
  })
  return { store, createStore }
}

const FRAME_ORIGIN = 'https://sim.example'
const BRIDGE = 'bridge-identifier-1234'

const body = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  workspaceId: 'workspace-one',
  surface: 'hq',
  platform: 'web',
  bridgeId: BRIDGE,
  ...overrides,
})

const request = (headers: Record<string, string> = {}) =>
  new Request('https://app.example/api/sim/launch', { method: 'POST', headers })

type Ports = {
  resolvePrincipal: (request: Request) => { userId: string } | null
  authorizeWorkspace: (
    principal: { userId: string },
    action: 'workspace.read',
    workspaceId: string
  ) => boolean
  policy: (scope: { workspaceId: string; surface: string }) => unknown
}

function ports(overrides: Partial<Ports> = {}): Ports {
  return {
    resolvePrincipal: () => ({ userId: 'user-one' }),
    authorizeWorkspace: () => true,
    policy: () => 'entitled',
    ...overrides,
  }
}

function service(
  options: Partial<Parameters<typeof createSimLaunchService>[0]> = {},
  portOverrides: Partial<Ports> = {}
) {
  const memory = memoryStore()
  const launch = createSimLaunchService({
    frameOrigin: FRAME_ORIGIN,
    createStore: memory.createStore,
    ports: ports(portOverrides) as never,
    now: () => 1_000,
    ...options,
  })
  return { memory, launch }
}

test('an entitled principal receives a code bound to the verified workspace, bridge and surface', async () => {
  const { memory, launch } = service()
  const result = await launch(request(), body())
  expect(result.status).toBe('granted')
  if (result.status !== 'granted') return
  expect(result.frameOrigin).toBe(FRAME_ORIGIN)
  expect(result.surface).toBe('hq')
  const row = memory.store.rows.get(result.code)!
  expect(row.workspaceId).toBe('workspace-one')
  expect(row.binding).toEqual({ bridgeId: BRIDGE, origin: FRAME_ORIGIN, surface: 'hq' })
  expect(row.expiresAt).toBeGreaterThan(1_000)
})

test('the entitlement composition decides, and a membership answer alone never grants', async () => {
  const asked: unknown[] = []
  const { launch } = service(
    {},
    {
      policy: (scope) => {
        asked.push(scope)
        return 'entitled'
      },
    }
  )
  const granted = await launch(request(), body())
  expect(granted.status).toBe('granted')
  expect(asked).toEqual([{ workspaceId: 'workspace-one', surface: 'hq', platform: 'web' }])
})

test('a request without an authenticated principal is denied and no policy is asked', async () => {
  let asked = 0
  const { launch } = service(
    {},
    {
      resolvePrincipal: () => null,
      policy: () => {
        asked += 1
        return 'entitled'
      },
    }
  )
  const result = await launch(request(), body())
  expect(result).toEqual({ status: 'denied', reason: 'unauthenticated' })
  expect(asked).toBe(0)
})

test('a principal without workspace read is not entitled and no policy is asked', async () => {
  let asked = 0
  const { launch } = service(
    {},
    {
      authorizeWorkspace: () => false,
      policy: () => {
        asked += 1
        return 'entitled'
      },
    }
  )
  const result = await launch(request(), body())
  expect(result).toEqual({ status: 'denied', reason: 'not_entitled' })
  expect(asked).toBe(0)
})

test('an invalid entitlement answer stays closed instead of granting', async () => {
  for (const answer of ['granted', true, '', null, undefined, 42]) {
    const { launch } = service({}, { policy: () => answer })
    const result = await launch(request(), body())
    expect(result).toEqual({ status: 'unavailable', reason: 'service_unavailable' })
  }
})

test('a throwing entitlement source is unavailable and nothing is issued', async () => {
  const { memory, launch } = service(
    {},
    {
      policy: () => {
        throw new Error('the entitlement source is down')
      },
    }
  )
  const result = await launch(request(), body())
  expect(result).toEqual({ status: 'unavailable', reason: 'service_unavailable' })
  expect(memory.store.rows.size).toBe(0)
})

test('a storage failure is unavailable and no code is granted', async () => {
  const { launch } = service({
    createStore: () => {
      throw new Error('the durable store is unavailable')
    },
  })
  const result = await launch(request(), body())
  expect(result).toEqual({ status: 'unavailable', reason: 'service_unavailable' })
})

test('a store that fails to write the code is unavailable, not granted', async () => {
  const { launch } = service({
    createStore: () => ({
      issue: () => {
        throw new Error('the code row could not be written')
      },
      redeem: () => ({ ok: false as const, reason: 'unknown' as const }),
    }),
  })
  const result = await launch(request(), body())
  expect(result).toEqual({ status: 'unavailable', reason: 'service_unavailable' })
})

test('without a configured hosting origin the launch is not configured and nothing is issued', async () => {
  const { memory, launch } = service({ frameOrigin: null })
  const result = await launch(request(), body())
  expect(result).toEqual({ status: 'unavailable', reason: 'not_configured' })
  expect(memory.store.rows.size).toBe(0)
})

test('a malformed launch body is invalid and never reaches the entitlement source', async () => {
  let asked = 0
  const { memory, launch } = service(
    {},
    {
      policy: () => {
        asked += 1
        return 'entitled'
      },
    }
  )
  for (const invalid of [
    body({ schemaVersion: 2 }),
    body({ surface: 'unknown' }),
    body({ bridgeId: 'x' }),
  ]) {
    expect(await launch(request(), invalid)).toEqual({ status: 'invalid_request' })
  }
  expect(asked).toBe(0)
  expect(memory.store.rows.size).toBe(0)
})

test('a granted code is spent by its first presentation and a replay is refused', async () => {
  const { memory, launch } = service()
  const granted = await launch(request(), body())
  if (granted.status !== 'granted') throw new Error('the launch was not granted')
  const presented = { bridgeId: BRIDGE, origin: FRAME_ORIGIN }
  expect(memory.store.redeem(granted.code, presented, 1_000)).toEqual({
    ok: true,
    surface: 'hq',
  })
  expect(memory.store.redeem(granted.code, presented, 1_000)).toEqual({
    ok: false,
    reason: 'code_used',
  })
})

test('an expired code is refused and a code presented elsewhere is refused', async () => {
  const { memory, launch } = service()
  const granted = await launch(request(), body())
  if (granted.status !== 'granted') throw new Error('the launch was not granted')
  expect(
    memory.store.redeem(granted.code, { bridgeId: BRIDGE, origin: FRAME_ORIGIN }, 10_000_000)
  ).toEqual({ ok: false, reason: 'code_expired' })

  const other = await launch(request(), body({ bridgeId: 'another-bridge-1234' }))
  if (other.status !== 'granted') throw new Error('the launch was not granted')
  expect(
    memory.store.redeem(other.code, { bridgeId: BRIDGE, origin: FRAME_ORIGIN }, 1_000)
  ).toEqual({ ok: false, reason: 'origin_refused' })
})

test('a code issued for another hosting origin is not redeemable here', async () => {
  const { memory, launch } = service()
  const granted = await launch(request(), body())
  if (granted.status !== 'granted') throw new Error('the launch was not granted')
  expect(
    memory.store.redeem(granted.code, { bridgeId: BRIDGE, origin: 'https://other.example' }, 1_000)
  ).toEqual({ ok: false, reason: 'origin_refused' })
})
