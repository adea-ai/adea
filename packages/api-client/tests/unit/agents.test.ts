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
  test('reads and provisions a structural lead through its workspace-scoped endpoint', async () => {
    const requests: Request[] = []
    const client = createApiClient({
      baseUrl: 'https://hq.example/api',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({
          lead: {
            ...agent,
            isWorkspaceLead: true,
            profile: { id: 'unconfigured', version: 'unconfigured', state: 'missing' },
          },
        })
      },
    })
    expect((await client.getWorkspaceLead('workspace/1')).lead?.isWorkspaceLead).toBe(true)
    await client.ensureWorkspaceLead('workspace/1')
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/v1/workspaces/workspace%2F1/agents/lead'],
      ['POST', '/api/v1/workspaces/workspace%2F1/agents/lead'],
    ])
    expect(await requests[1]!.json()).toEqual({})
  })
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
    await client.assignAgentToProject('workspace-1', 'agent-1', {
      expectedRevision: 0,
      projectId: 'project-1',
    })
    await client.updateAgentPresentation('workspace-1', 'agent-1', {
      avatarRef: 'avatar:ada',
      expectedRevision: 1,
    })
    await client.changeAgentProfile('workspace-1', 'agent-1', {
      expectedRevision: 0,
      profileId: 'engineer',
      profileVersion: '2',
    })
    await client.archiveAgent('workspace-1', 'agent-1')

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/v1/workspaces/workspace-1/agents'],
      ['POST', '/api/v1/workspaces/workspace-1/agents'],
      ['POST', '/api/v1/workspaces/workspace-1/agents/agent-1/project'],
      ['PATCH', '/api/v1/workspaces/workspace-1/agents/agent-1/presentation'],
      ['POST', '/api/v1/workspaces/workspace-1/agents/agent-1/profile'],
      ['DELETE', '/api/v1/workspaces/workspace-1/agents/agent-1'],
    ])
  })
  test('sends the opening revision with every presentation and placement edit', async () => {
    const requests: Request[] = []
    const client = createApiClient({
      baseUrl: 'https://hq.example/api',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({ agent: { ...agent, revision: 1 } })
      },
    })
    await client.assignAgentToProject('workspace-1', 'agent-1', {
      expectedRevision: 0,
      projectId: null,
    })
    await client.updateAgentPresentation('workspace-1', 'agent-1', {
      expectedRevision: 1,
      name: 'Ada Lovelace',
      roleSummary: null,
    })

    expect(await requests[0]!.json()).toEqual({ expectedRevision: 0, projectId: null })
    expect(await requests[1]!.json()).toEqual({
      expectedRevision: 1,
      name: 'Ada Lovelace',
      roleSummary: null,
    })
  })
})
