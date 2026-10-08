import { expect, test } from 'bun:test'
import { AgentHqApiClient } from '../../src'

test('lead commands use only canonical intent paths and empty bodies; reload uses canonical channel', async () => {
  const requests: Request[] = []
  const client = new AgentHqApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      requests.push(new Request(`https://test${input}`, init))
      return Response.json({ leadTurn: null, events: [], nextSequence: 0 })
    },
  })
  await client.prepareLeadTurn('workspace/1', 'intent/1')
  await client.dispatchLeadTurn('workspace/1', 'intent/1')
  await client.getLeadTurnStatus('workspace/1', 'intent/1')
  await client.getLeadTurnProgress('workspace/1', 'intent/1', 7)
  await client.cancelLeadTurn('workspace/1', 'intent/1')
  await client.getChannelLeadTurn('workspace/1', 'channel/1')
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/api/v1/workspaces/workspace%2F1/lead-turns/intent%2F1/prepare',
    '/api/v1/workspaces/workspace%2F1/lead-turns/intent%2F1',
    '/api/v1/workspaces/workspace%2F1/lead-turns/intent%2F1',
    '/api/v1/workspaces/workspace%2F1/lead-turns/intent%2F1/progress',
    '/api/v1/workspaces/workspace%2F1/lead-turns/intent%2F1/cancel',
    '/api/v1/workspaces/workspace%2F1/channels/channel%2F1/lead-turn',
  ])
  for (const request of requests.filter((value) => value.method === 'POST'))
    expect(await request.json()).toEqual({})
  expect(new URL(requests[3]!.url).searchParams.get('afterSequence')).toBe('7')
  await expect(client.getLeadTurnProgress('w', 'i', -1)).rejects.toThrow(
    'Invalid lead progress cursor'
  )
  expect(requests).toHaveLength(6)
})
