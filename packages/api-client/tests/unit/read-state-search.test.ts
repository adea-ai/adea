import { describe, expect, test } from 'bun:test'

import { AgentHqApiClient } from '../../src'

describe('read state and workspace search API client', () => {
  test('encodes scoped routes, bodies, pagination, and cancellation', async () => {
    const requests: Request[] = []
    const signals: Array<AbortSignal | null | undefined> = []
    const client = new AgentHqApiClient({
      baseUrl: '/api',
      fetchImpl: async (input, init) => {
        signals.push(init?.signal)
        requests.push(new Request(`https://test${input}`, init))
        return Response.json(
          input.toString().includes('/search')
            ? { privateResultsUnavailable: false, results: [] }
            : { readState: [] }
        )
      },
    })
    await client.getReadState('workspace/1')
    await client.setChannelReadState('workspace/1', 'channel/1', {
      action: 'read',
      lastReadSequence: 42,
    })
    await client.setThreadReadState('workspace/1', 'channel/1', 'message/1', {
      action: 'unread',
    })
    await client.markAllRead('workspace/1')
    const abort = new AbortController()
    await client.searchWorkspace('workspace/1', 'release notes', {
      channelId: 'channel/1',
      limit: 20,
      offset: 40,
      signal: abort.signal,
    })

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/v1/workspaces/workspace%2F1/read-state',
      '/api/v1/workspaces/workspace%2F1/read-state/channels/channel%2F1',
      '/api/v1/workspaces/workspace%2F1/read-state/threads/message%2F1',
      '/api/v1/workspaces/workspace%2F1/read-state',
      '/api/v1/workspaces/workspace%2F1/search',
    ])
    expect(await requests[1]!.json()).toEqual({ action: 'read', lastReadSequence: 42 })
    expect(await requests[2]!.json()).toEqual({ action: 'unread', channelId: 'channel/1' })
    expect(await requests[3]!.json()).toEqual({ action: 'read_all' })
    expect(new URL(requests[4]!.url).searchParams.toString()).toBe(
      'q=release+notes&channelId=channel%2F1&limit=20&offset=40'
    )
    expect(signals[4]).toBe(abort.signal)
  })
})
