import { describe, expect, test } from 'bun:test'

import {
  handleMarketplaceInstallationRequest,
  parseMarketplaceInstallationInput,
  type MarketplaceInstallationOperation,
  type MarketplaceInstallationRequestDependencies,
} from '../src/server/marketplace-installation-request'
import { MarketplaceProxyError } from '../src/server/marketplace-proxy'
import type { WorkspacePrincipalResolution } from '../src/server/workspace-principal'

const installationId = 'ins_0123456789abcdef0123456789'
const workspaceId = '10000000-0000-4000-8000-000000000001'

const resolution = {
  clearTemporaryCredential: false,
  principal: { kind: 'user', userId: 'user-1' },
  sessionRotated: false,
  temporary: false,
} as unknown as WorkspacePrincipalResolution

function post(body: unknown, init: RequestInit = {}) {
  return new Request('https://adea.example/api/marketplace/installations/uninstall', {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    ...init,
  })
}

type Recorded = {
  permissions: string[]
  proxied: { installationId: string; userId: string; scope: unknown }[]
}

function dependencies(
  recorded: Recorded,
  overrides: Partial<MarketplaceInstallationRequestDependencies> & { allowed?: boolean } = {}
): MarketplaceInstallationRequestDependencies {
  return {
    authorize: async (_principal, permission) => {
      recorded.permissions.push(permission)
      return { allowed: overrides.allowed ?? true }
    },
    proxy: async (input, _inbound, proxyDependencies) => {
      recorded.proxied.push({
        ...input,
        scope: await proxyDependencies.resolveControlPlaneScope?.(),
      })
      return Response.json({ installation: { installationId, state: 'uninstalled' } })
    },
    resolvePrincipal: async () => resolution,
    scopeResolver: (id) => async () => ({ workspaceId: `mapped:${id}` }),
    ...overrides,
  }
}

const operations: readonly MarketplaceInstallationOperation[] = ['get', 'uninstall']

describe('marketplace installation routes', () => {
  test('uninstall needs workspace.update, as install does; get needs workspace.read', async () => {
    for (const [operation, permission] of [
      ['get', 'workspace.read'],
      ['uninstall', 'workspace.update'],
    ] as const) {
      const recorded: Recorded = { permissions: [], proxied: [] }
      const response = await handleMarketplaceInstallationRequest(
        operation,
        post({ installationId, workspaceId }),
        dependencies(recorded)
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(recorded.permissions).toEqual([permission])
      // The proxy reaches the caller's own workspace scope, with the
      // authenticated user, never a body-supplied identity.
      expect(recorded.proxied).toEqual([
        { installationId, scope: { workspaceId: `mapped:${workspaceId}` }, userId: 'user-1' },
      ])
    }
  })

  test.each(operations)('%s denies an unauthenticated caller before parsing', async (operation) => {
    const recorded: Recorded = { permissions: [], proxied: [] }
    const response = await handleMarketplaceInstallationRequest(
      operation,
      post({ installationId, workspaceId }),
      dependencies(recorded, { resolvePrincipal: async () => null })
    )
    expect(response.status).toBe(401)
    expect(recorded.permissions).toEqual([])
    expect(recorded.proxied).toEqual([])
  })

  test.each(operations)(
    '%s denies a caller without the workspace permission',
    async (operation) => {
      const recorded: Recorded = { permissions: [], proxied: [] }
      const response = await handleMarketplaceInstallationRequest(
        operation,
        post({ installationId, workspaceId }),
        dependencies(recorded, { allowed: false })
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        code: 'workspace_unavailable',
        message: 'Workspace unavailable',
      })
      expect(recorded.proxied).toEqual([])
    }
  )

  test.each(operations)('%s rejects malformed bodies without authorizing', async (operation) => {
    for (const body of [
      'not json',
      { workspaceId },
      { installationId, workspaceId, workspaceIdentity: { userId: 'someone-else' } },
      { installationId: 'ins_UPPER', workspaceId },
      { installationId, workspaceId: '' },
    ]) {
      const recorded: Recorded = { permissions: [], proxied: [] }
      const response = await handleMarketplaceInstallationRequest(
        operation,
        post(body),
        dependencies(recorded)
      )
      expect(response.status).toBe(400)
      expect(recorded.permissions).toEqual([])
      expect(recorded.proxied).toEqual([])
    }
  })

  test('rejects a desktop-marked request from an untrusted origin', async () => {
    const recorded: Recorded = { permissions: [], proxied: [] }
    const response = await handleMarketplaceInstallationRequest(
      'uninstall',
      post(
        { installationId, workspaceId },
        {
          headers: {
            'content-type': 'application/json',
            origin: 'https://evil.example',
            'x-adea-client': 'desktop',
          },
        }
      ),
      dependencies(recorded)
    )
    expect(response.status).toBe(403)
    expect(recorded.permissions).toEqual([])
    expect(recorded.proxied).toEqual([])
  })

  test('surfaces proxy failures without upstream detail', async () => {
    const recorded: Recorded = { permissions: [], proxied: [] }
    const response = await handleMarketplaceInstallationRequest(
      'uninstall',
      post({ installationId, workspaceId }),
      dependencies(recorded, {
        proxy: async () => {
          throw new MarketplaceProxyError(
            'MARKETPLACE_REQUEST_REJECTED',
            'Control Plane rejected the marketplace request',
            404,
            'MARKETPLACE_INSTALLATION_NOT_FOUND'
          )
        },
      })
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      code: 'MARKETPLACE_REQUEST_REJECTED',
      message: 'Control Plane rejected the marketplace request',
    })
  })

  test('parses exactly the two bounded identifiers', () => {
    expect(parseMarketplaceInstallationInput({ installationId, workspaceId })).toEqual({
      installationId,
      workspaceId,
    })
    expect(parseMarketplaceInstallationInput([installationId])).toBeNull()
    expect(
      parseMarketplaceInstallationInput({ installationId, workspaceId: 'x'.repeat(257) })
    ).toBeNull()
  })
})
