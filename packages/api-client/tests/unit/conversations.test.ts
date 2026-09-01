import { describe, expect, test } from 'bun:test'

import { AgentHqApiClient } from '../../src'

describe('conversation API client', () => {
  test('uses versioned Channel and Message routes with conflict and retry metadata', async () => {
    const requests: Request[] = []
    const client = new AgentHqApiClient({
      baseUrl: '/api',
      fetchImpl: async (input, init) => {
        requests.push(new Request(`https://test${input}`, init))
        return Response.json({ channel: { id: 'channel-1' }, message: { id: 'message-1' } })
      },
    })
    await client.createGroupChannel('workspace/1', {
      idempotencyKey: 'group-1',
      title: 'Group',
    })
    await client.createMessage('workspace/1', 'channel/1', {
      bodyText: 'Hello',
      idempotencyKey: 'message-1',
    })
    await client.editMessage('workspace/1', 'message/1', { bodyText: 'Edited' }, 1)

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/v1/workspaces/workspace%2F1/channels',
      '/api/v1/workspaces/workspace%2F1/channels/channel%2F1/messages',
      '/api/v1/workspaces/workspace%2F1/messages/message%2F1',
    ])
    expect(requests[0]?.headers.get('idempotency-key')).toBe('group-1')
    expect(requests[1]?.headers.get('idempotency-key')).toBe('message-1')
    expect(requests[2]?.headers.get('if-match')).toBe('1')
  })

  test('encodes stable Message pagination', async () => {
    let request: Request | undefined
    const client = new AgentHqApiClient({
      baseUrl: '/api',
      fetchImpl: async (input, init) => {
        request = new Request(`https://test${input}`, init)
        return Response.json({ messages: [] })
      },
    })
    await client.listMessages('w', 'c', { afterSequence: 42, limit: 25, threadRootMessageId: 'm' })
    expect(request?.url).toBe(
      'https://test/api/v1/workspaces/w/channels/c/messages?afterSequence=42&limit=25&threadRootMessageId=m'
    )
  })
})
