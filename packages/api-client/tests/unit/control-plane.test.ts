import { describe, expect, test } from 'bun:test'
import { createApiClient } from '../../src'

describe('Workspace Skills and Cloud connections API client', () => {
  test('routes every call under the workspace and keeps secrets out of URLs', async () => {
    const requests: Request[] = []
    const client = createApiClient({
      baseUrl: 'https://hq.example/api',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({})
      },
    })
    const key = 'idempotency-key-0001'
    await client.listWorkspaceSkills('workspace 1')
    await client.listWorkspaceAgentProfiles('workspace 1', 'cur_next')
    await client.publishWorkspaceSkill('workspace 1', {
      content: { instructions: 'x' },
      displayName: 'Release notes',
      idempotencyKey: key,
      manifest: { semanticVersion: '1.0.0' },
    })
    await client.changeWorkspaceCatalogLifecycle(
      'workspace 1',
      { action: 'deprecate', id: 'skl_1', kind: 'skill' },
      { idempotencyKey: key, reason: 'Replaced' }
    )
    await client.changeWorkspaceCatalogLifecycle(
      'workspace 1',
      { action: 'revoke', id: 'prf_1', kind: 'profile' },
      { idempotencyKey: key, reason: 'Retired' }
    )
    await client.listCloudConnections('workspace 1')
    await client.createCloudConnection('workspace 1', {
      connectorRef: 'connector:github',
      idempotencyKey: key,
      provider: 'github',
      secret: 'secret-value-canary',
    })
    await client.rotateCloudConnection('workspace 1', 'crd_1', {
      expectedRevision: 1,
      idempotencyKey: key,
      secret: 'secret-value-canary',
    })
    await client.revokeCloudConnection('workspace 1', 'crd_1', { idempotencyKey: key })

    expect(
      requests.map((request) => [
        request.method,
        new URL(request.url).pathname + new URL(request.url).search,
      ])
    ).toEqual([
      ['GET', '/api/workspaces/workspace%201/skills'],
      ['GET', '/api/workspaces/workspace%201/skills/profiles?cursor=cur_next'],
      ['POST', '/api/workspaces/workspace%201/skills'],
      ['POST', '/api/workspaces/workspace%201/skills/skl_1/deprecate'],
      ['POST', '/api/workspaces/workspace%201/skills/profiles/prf_1/revoke'],
      ['GET', '/api/workspaces/workspace%201/cloud-connections'],
      ['POST', '/api/workspaces/workspace%201/cloud-connections'],
      ['POST', '/api/workspaces/workspace%201/cloud-connections/crd_1/rotate'],
      ['POST', '/api/workspaces/workspace%201/cloud-connections/crd_1/revoke'],
    ])
    for (const request of requests) expect(request.url).not.toContain('secret-value-canary')
    expect(await requests[6]!.json()).toMatchObject({ secret: 'secret-value-canary' })
    expect(requests[6]!.headers.get('content-type')).toBe('application/json')
  })
})
