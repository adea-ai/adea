import { describe, expect, test } from 'bun:test'

import { createApiClient } from '../../src'

const room = {
  createdAt: '2026-08-30T00:00:00.000Z',
  functionKey: 'engineering',
  id: 'room-1',
  layoutRef: 'layout:work/engineering',
  lifecycleState: 'active' as const,
  name: 'Engineering',
  sortOrder: 0,
  templateKey: 'work.engineering',
  updatedAt: '2026-08-30T00:00:00.000Z',
  workspaceId: 'workspace-1',
}

describe('room API client', () => {
  test('uses versioned room collection and detail contracts', async () => {
    const requests: Request[] = []
    const client = createApiClient({
      baseUrl: 'https://hq.example/api',
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (new URL(request.url).pathname.endsWith('/room-1')) return Response.json({ room })
        if (request.method === 'POST') return Response.json({ room }, { status: 201 })
        if (request.method === 'PATCH') return Response.json({ room })
        if (request.method === 'DELETE') return Response.json({ archived: true })
        return Response.json([room])
      },
    })

    await expect(client.listRooms('workspace-1')).resolves.toEqual([room])
    await expect(client.getRoom('workspace-1', 'room-1')).resolves.toEqual({ room })
    await client.createRoom('workspace-1', {
      functionKey: 'engineering',
      layoutRef: 'layout:work/engineering',
      name: 'Engineering',
      templateKey: 'work.engineering',
    })
    await client.updateRoom('workspace-1', 'room/1', { name: 'Product Engineering' })
    await client.archiveRoom('workspace-1', 'room/1')

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/v1/workspaces/workspace-1/rooms'],
      ['GET', '/api/v1/workspaces/workspace-1/rooms/room-1'],
      ['POST', '/api/v1/workspaces/workspace-1/rooms'],
      ['PATCH', '/api/v1/workspaces/workspace-1/rooms/room%2F1'],
      ['DELETE', '/api/v1/workspaces/workspace-1/rooms/room%2F1'],
    ])
  })

  test('reorders rooms through one deterministic mutation', async () => {
    let request: Request | undefined
    const client = createApiClient({
      baseUrl: 'https://hq.example/api',
      fetchImpl: async (input, init) => {
        request = new Request(input, init)
        return Response.json([room])
      },
    })

    await client.reorderRooms('workspace-1', ['room-2', 'room-1'])
    expect(new URL(request!.url).pathname).toBe('/api/v1/workspaces/workspace-1/rooms/reorder')
    expect(request?.method).toBe('POST')
    expect(await request?.json()).toEqual({ roomIds: ['room-2', 'room-1'] })
  })
})
