import { describe, expect, test } from 'bun:test'

import { AgentHqApiClient } from '../../src'

describe('Marketplace API client', () => {
  test('uses same-origin marketplace routes and sends exact install pins', async () => {
    const requests: Request[] = []
    const client = new AgentHqApiClient({
      baseUrl: '/api',
      fetchImpl: async (input, init) => {
        const request = new Request(`https://agent-hq.example${input}`, init)
        requests.push(request)
        return Response.json(
          request.url.endsWith('/catalog')
            ? {
                artifacts: {},
                catalogId: 'catalog:test',
                installations: [],
                releaseId: 'catalog:test',
              }
            : request.url.endsWith('/install-plan')
              ? {
                  allowedToActivate: false,
                  approvalRequired: true,
                  compatibility: 'full',
                  instanceId: 'marketplace:test',
                  planVersion: 2,
                  pluginId: 'plugin:openai-official:gmail',
                  releaseId: `release:${'b'.repeat(64)}`,
                  strategy: 'native-agent-plugin',
                }
              : {
                  canonicalContentDigest: 'sha256:test',
                  installationId: 'ins_test',
                  releaseId: 'release:test',
                  state: 'pending-authorization',
                }
        )
      },
    })
    await client.getMarketplaceCatalog('workspace-1')
    await client.requestMarketplaceInstallPlan('workspace-1', {
      instanceId: 'marketplace:test',
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'b'.repeat(64)}`,
      requestedHarness: 'codex',
      workspaceIdentity: { userId: 'user-1', workspaceId: 'workspace-1' },
    })
    await client.requestMarketplaceInstall('workspace-1', {
      canonicalContentDigest: `sha256:${'a'.repeat(64)}`,
      idempotencyKey: 'marketplace-install-1',
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'b'.repeat(64)}`,
      requestedHarness: 'codex',
      workspaceIdentity: { userId: 'user-1', workspaceId: 'workspace-1' },
    })

    expect(requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ['POST', '/api/marketplace/catalog'],
      ['POST', '/api/marketplace/install-plan'],
      ['POST', '/api/marketplace/install'],
    ])
    expect(await requests[1]!.json()).toMatchObject({
      instanceId: 'marketplace:test',
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'b'.repeat(64)}`,
      requestedHarness: 'codex',
    })
    expect(await requests[2]!.json()).toMatchObject({
      canonicalContentDigest: `sha256:${'a'.repeat(64)}`,
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'b'.repeat(64)}`,
      requestedHarness: 'codex',
    })
    expect(requests[2]?.url).not.toContain('github.com')
  })

  test('reads and uninstalls one installation through same-origin routes', async () => {
    const requests: Request[] = []
    const installation = {
      canonicalContentDigest: `sha256:${'a'.repeat(64)}`,
      catalogId: `catalog:${'c'.repeat(64)}`,
      installationId: 'ins_0123456789abcdef0123456789',
      installedAt: '2026-10-06T00:00:00.000Z',
      installedBy: 'user-1',
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'b'.repeat(64)}`,
      requestedHarness: 'codex',
      state: 'installed',
      updatedAt: '2026-10-06T00:00:00.000Z',
    }
    const client = new AgentHqApiClient({
      baseUrl: '/api',
      fetchImpl: async (input, init) => {
        const request = new Request(`https://agent-hq.example${input}`, init)
        requests.push(request)
        return Response.json(
          request.url.endsWith('/uninstall')
            ? { installation: { ...installation, state: 'uninstalled' }, replayed: false }
            : { installation }
        )
      },
    })

    const read = await client.getMarketplaceInstallation('workspace-1', installation.installationId)
    const removed = await client.uninstallMarketplaceInstallation(
      'workspace-1',
      installation.installationId
    )

    expect(read.installation.state).toBe('installed')
    expect(removed).toMatchObject({ installation: { state: 'uninstalled' }, replayed: false })
    expect(requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ['POST', '/api/marketplace/installations/get'],
      ['POST', '/api/marketplace/installations/uninstall'],
    ])
    for (const request of requests)
      expect(await request.json()).toEqual({
        installationId: installation.installationId,
        workspaceId: 'workspace-1',
      })
  })
})
