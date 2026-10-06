import { expect, test } from 'bun:test'

import { AgentHqApiClient } from '../../src'

test('reads the account summary from the account-scoped route', async () => {
  const requests: Request[] = []
  const summary = {
    workspaces: [{ mentions: 1, unreadChannels: 2, workspaceId: 'workspace-1' }],
  }
  const client = new AgentHqApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      requests.push(new Request(`https://test${input}`, init))
      return Response.json(summary)
    },
  })

  expect(await client.accountSummary()).toEqual(summary)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.method).toBe('GET')
  expect(new URL(requests[0]!.url).pathname).toBe('/api/v1/account/summary')
})
