import { expect, test } from 'bun:test'
import type { SimEntitlementQuery } from '@adea-ai/spatial/sim-bridge'
import {
  bindSimLaunchEntitlement,
  createSimAssetEntitlement,
  type SimEntitlementScope,
  type SimLaunchEntitlementPorts,
} from '../src/server/sim-entitlement'
import { createSimHost } from '../src/server/sim-host'

// Fakes only: the principal resolver, the workspace authorizer and the policy are in-memory functions here.
type Principal = Readonly<{ id: string }>

const query: SimEntitlementQuery = {
  workspaceId: 'workspace-one',
  surface: 'hq',
  platform: 'desktop',
}
const request = (probe = 'one') =>
  new Request(`https://app.example/api/sim/launch?probe=${probe}`, { method: 'POST' })

function ports(
  overrides: Partial<SimLaunchEntitlementPorts<Principal>> = {}
): SimLaunchEntitlementPorts<Principal> {
  return {
    resolvePrincipal: async () => ({ id: 'account-one' }),
    authorizeWorkspace: async () => true,
    policy: async () => 'entitled',
    ...overrides,
  }
}

test('no authenticated principal is unauthenticated, and no other port is asked', async () => {
  const asked: string[] = []
  const check = bindSimLaunchEntitlement(
    request(),
    ports({
      resolvePrincipal: async () => null,
      authorizeWorkspace: async () => {
        asked.push('authorize')
        return true
      },
      policy: async () => {
        asked.push('policy')
        return 'entitled'
      },
    })
  )
  expect(await check(query)).toBe('unauthenticated')
  expect(asked).toEqual([])
})

test('a principal that cannot read the workspace is not entitled, and the policy is not asked', async () => {
  const asked: string[] = []
  const check = bindSimLaunchEntitlement(
    request(),
    ports({
      authorizeWorkspace: async () => false,
      policy: async () => {
        asked.push('policy')
        return 'entitled'
      },
    })
  )
  expect(await check(query)).toBe('not_entitled')
  expect(asked).toEqual([])
})

test('only a literal true authorizes the read, so truthy look-alikes deny', async () => {
  for (const answer of ['yes', 1, 'true', { allowed: true }]) {
    const check = bindSimLaunchEntitlement(
      request(),
      ports({ authorizeWorkspace: async () => answer, policy: async () => 'entitled' })
    )
    expect(await check(query)).toBe('not_entitled')
  }
})

test('membership alone never entitles: a missing, misspelled or non-string policy answer is unavailable', async () => {
  for (const answer of [undefined, null, true, 'ENTITLED', 'entitled ', { verdict: 'entitled' }]) {
    const check = bindSimLaunchEntitlement(
      request(),
      ports({ authorizeWorkspace: async () => true, policy: async () => answer })
    )
    expect(await check(query)).toBe('unavailable')
  }
})

test('only the explicit policy returns entitled, and it is asked about exactly the scope requested', async () => {
  const scopes: SimEntitlementScope[] = []
  const check = bindSimLaunchEntitlement(
    request(),
    ports({
      policy: async (scope) => {
        scopes.push(scope)
        return 'entitled'
      },
    })
  )
  expect(await check(query)).toBe('entitled')
  expect(scopes).toEqual([{ workspaceId: 'workspace-one', surface: 'hq', platform: 'desktop' }])
})

test('the policy refusals pass through, and a throwing or rejecting policy is unavailable', async () => {
  for (const answer of ['not_entitled', 'unauthenticated', 'unavailable'] as const) {
    const check = bindSimLaunchEntitlement(request(), ports({ policy: async () => answer }))
    expect(await check(query)).toBe(answer)
  }
  const throwing = bindSimLaunchEntitlement(
    request(),
    ports({
      policy: () => {
        throw new Error('policy source offline')
      },
    })
  )
  expect(await throwing(query)).toBe('unavailable')
  const rejecting = bindSimLaunchEntitlement(
    request(),
    ports({ policy: async () => Promise.reject(new Error('policy source offline')) })
  )
  expect(await rejecting(query)).toBe('unavailable')
})

test('a throwing principal resolver or authorizer is unavailable, and nothing is entitled', async () => {
  const resolverThrows = bindSimLaunchEntitlement(
    request(),
    ports({
      resolvePrincipal: async () => {
        throw new Error('session store offline')
      },
    })
  )
  expect(await resolverThrows(query)).toBe('unavailable')
  const authorizerThrows = bindSimLaunchEntitlement(
    request(),
    ports({
      authorizeWorkspace: async () => {
        throw new Error('authorization offline')
      },
    })
  )
  expect(await authorizerThrows(query)).toBe('unavailable')
})

test('a malformed scope is unavailable before any port is asked', async () => {
  const asked: string[] = []
  const check = bindSimLaunchEntitlement(
    request(),
    ports({
      resolvePrincipal: async () => {
        asked.push('resolve')
        return { id: 'account-one' }
      },
    })
  )
  expect(await check({ ...query, workspaceId: '' })).toBe('unavailable')
  expect(await check({ ...query, surface: 'lobby' as never })).toBe('unavailable')
  expect(asked).toEqual([])
})

test('each checker resolves only the principal of its own request', async () => {
  const seen: string[] = []
  const shared = ports({
    resolvePrincipal: async (received) => ({
      id: new URL(received.url).searchParams.get('probe')!,
    }),
    authorizeWorkspace: async (principal) => {
      seen.push(principal.id)
      return principal.id === 'a'
    },
  })
  const checkA = bindSimLaunchEntitlement(request('a'), shared)
  const checkB = bindSimLaunchEntitlement(request('b'), shared)
  expect(await checkA(query)).toBe('entitled')
  expect(await checkB(query)).toBe('not_entitled')
  expect(seen).toEqual(['a', 'b'])
})

test('the asset-time verdict is the policy answer for the stored scope, with no other input', async () => {
  const scopes: unknown[] = []
  const check = createSimAssetEntitlement(async (scope) => {
    scopes.push(scope)
    return 'entitled'
  })
  expect(await check({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('entitled')
  expect(scopes).toEqual([{ workspaceId: 'workspace-one', surface: 'hq' }])
})

test('asset-time policy refusals pass through, and every unknown answer is closed', async () => {
  for (const answer of ['not_entitled', 'unauthenticated', 'unavailable'] as const) {
    const check = createSimAssetEntitlement(async () => answer)
    expect(await check({ workspaceId: 'workspace-one', surface: 'hq' })).toBe(answer)
  }
  for (const answer of [undefined, null, true, 'ENTITLED', 'entitled ', {}]) {
    const check = createSimAssetEntitlement(async () => answer)
    expect(await check({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('unavailable')
  }
  const throwing = createSimAssetEntitlement(() => {
    throw new Error('policy source offline')
  })
  expect(await throwing({ workspaceId: 'workspace-one', surface: 'hq' })).toBe('unavailable')
})

test('a malformed stored scope is unavailable, and the policy is never asked', async () => {
  const asked: unknown[] = []
  const check = createSimAssetEntitlement(async (scope) => {
    asked.push(scope)
    return 'entitled'
  })
  expect(await check({ workspaceId: '', surface: 'hq' })).toBe('unavailable')
  expect(await check({ workspaceId: 'workspace-one', surface: 'lobby' as never })).toBe(
    'unavailable'
  )
  expect(await check({ workspaceId: 7 as never, surface: 'hq' })).toBe('unavailable')
  expect(asked).toEqual([])
})

test('the composed asset policy governs a private read: a denial reads no storage, an entitlement serves the entry', async () => {
  const token = 'v'.repeat(40)
  const now = 1_000
  const reads: string[] = []
  const build = (answer: 'not_entitled' | 'entitled') =>
    createSimHost({
      origin: 'https://sim.example',
      parentOrigins: ['https://app.example'],
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
      session: async (value) =>
        value === token
          ? { workspaceId: 'workspace-one', surface: 'hq', expiresAt: now + 60_000 }
          : null,
      entitlement: createSimAssetEntitlement(async () => answer),
      now: () => now,
      readAsset: async (path) => {
        reads.push(path)
        return { body: 'private-engine-fixture', contentType: 'text/javascript' }
      },
    })
  const get = (host: ReturnType<typeof build>) =>
    host(
      new Request('https://sim.example/assets/agent-sim/engine.js', {
        headers: { cookie: `__Host-adea-sim=${token}` },
      })
    )

  const denied = await get(build('not_entitled'))
  expect(denied.status).toBe(403)
  expect(reads).toEqual([])

  const served = await get(build('entitled'))
  expect(served.status).toBe(200)
  expect(await served.text()).toBe('private-engine-fixture')
  expect(reads).toEqual(['engine.js'])
})
