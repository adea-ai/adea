import { describe, expect, test } from 'bun:test'
import { createApiClient } from '../../src'

const agent = {
  createdAt: '2026-08-30T00:00:00.000Z',
  id: 'agent-1',
  lifecycleState: 'active' as const,
  name: 'Ada',
  presentationMetadata: {},
  profile: { id: 'engineer', state: 'available' as const, version: '1' },
  updatedAt: '2026-08-30T00:00:00.000Z',
  workspaceId: 'workspace-1',
}

describe('Agent API client', () => {
  test('uses stable Agent identity for CRUD, assignment, presentation, and profile changes', async () => {
    const requests: Request[] = []
    const client = createApiClient({
      baseUrl: 'https://hq.example/api',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({ agent })
      },
    })
    await client.listAgents('workspace-1')
    await client.createAgent('workspace-1', {
      name: 'Ada',
      profileId: 'engineer',
      profileVersion: '1',
    })
    await client.assignAgentToRoom('workspace-1', 'agent-1', 'room-1')
    await client.updateAgentPresentation('workspace-1', 'agent-1', { avatarRef: 'avatar:ada' })
    await client.changeAgentProfile('workspace-1', 'agent-1', {
      profileId: 'engineer',
      profileVersion: '2',
    })
    await client.archiveAgent('workspace-1', 'agent-1')

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/v1/workspaces/workspace-1/agents'],
      ['POST', '/api/v1/workspaces/workspace-1/agents'],
      ['POST', '/api/v1/workspaces/workspace-1/agents/agent-1/room'],
      ['PATCH', '/api/v1/workspaces/workspace-1/agents/agent-1/presentation'],
      ['POST', '/api/v1/workspaces/workspace-1/agents/agent-1/profile'],
      ['DELETE', '/api/v1/workspaces/workspace-1/agents/agent-1'],
    ])
  })
})
