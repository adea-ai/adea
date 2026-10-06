import { describe, expect, test } from 'bun:test'

import { createApiClient } from '../../src'

const project = {
  createdAt: '2026-08-30T00:00:00.000Z',
  iconKey: 'engineering',
  id: 'project-1',
  layoutRef: 'layout:work/engineering',
  lifecycleState: 'active' as const,
  name: 'Engineering',
  sortOrder: 0,
  templateKey: 'work.engineering',
  updatedAt: '2026-08-30T00:00:00.000Z',
  workspaceId: 'workspace-1',
}

describe('project API client', () => {
  test('uses versioned project collection and detail contracts', async () => {
    const requests: Request[] = []
    const client = createApiClient({
      baseUrl: 'https://hq.example/api',
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (new URL(request.url).pathname.endsWith('/project-1')) return Response.json({ project })
        if (request.method === 'POST') return Response.json({ project }, { status: 201 })
        if (request.method === 'PATCH') return Response.json({ project })
        if (request.method === 'DELETE') return Response.json({ archived: true })
        return Response.json([project])
      },
    })

    await expect(client.listProjects('workspace-1')).resolves.toEqual([project])
    await expect(client.getProject('workspace-1', 'project-1')).resolves.toEqual({ project })
    await client.createProject('workspace-1', {
      iconKey: 'engineering',
      layoutRef: 'layout:work/engineering',
      name: 'Engineering',
      templateKey: 'work.engineering',
    })
    await client.updateProject('workspace-1', 'project/1', { name: 'Product Engineering' })
    await client.archiveProject('workspace-1', 'project/1')

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/v1/workspaces/workspace-1/projects'],
      ['GET', '/api/v1/workspaces/workspace-1/projects/project-1'],
      ['POST', '/api/v1/workspaces/workspace-1/projects'],
      ['PATCH', '/api/v1/workspaces/workspace-1/projects/project%2F1'],
      ['DELETE', '/api/v1/workspaces/workspace-1/projects/project%2F1'],
    ])
  })

  test('reorders projects through one deterministic mutation', async () => {
    let request: Request | undefined
    const client = createApiClient({
      baseUrl: 'https://hq.example/api',
      fetchImpl: async (input, init) => {
        request = new Request(input, init)
        return Response.json([project])
      },
    })

    await client.reorderProjects('workspace-1', ['project-2', 'project-1'])
    expect(new URL(request!.url).pathname).toBe('/api/v1/workspaces/workspace-1/projects/reorder')
    expect(request?.method).toBe('POST')
    expect(await request?.json()).toEqual({ projectIds: ['project-2', 'project-1'] })
  })
})
