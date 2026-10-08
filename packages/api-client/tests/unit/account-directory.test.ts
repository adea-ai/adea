import { expect, test } from 'bun:test'

import { AccountDirectoryApiClient } from '../../src/account-directory'

const page = {
  agents: [
    {
      createdAt: '2026-10-08T00:00:00.000Z',
      id: '10000000-0000-4000-8000-000000000001',
      isWorkspaceLead: false,
      lifecycleState: 'active',
      name: 'Atlas',
      profile: { id: 'prf_a', revision: 0, state: 'available', version: 'pfv_a' },
      updatedAt: '2026-10-08T00:00:00.000Z',
      workspaceId: '20000000-0000-4000-8000-000000000002',
    },
  ],
}

test('reads the account-wide agent directory from the account-scoped route', async () => {
  const requests: Request[] = []
  const client = new AccountDirectoryApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      requests.push(new Request(`https://test${input}`, init))
      return Response.json(page)
    },
  })

  expect(await client.accountAgentDirectory({ after: 'cursor-1', limit: 25 })).toEqual(page)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.method).toBe('GET')
  expect(new URL(requests[0]!.url).pathname).toBe('/api/v1/account/agents')
  expect(new URL(requests[0]!.url).search).toBe('?after=cursor-1&limit=25')
})

test('omits absent page parameters instead of sending empty markers', async () => {
  const requests: Request[] = []
  const client = new AccountDirectoryApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      requests.push(new Request(`https://test${input}`, init))
      return Response.json({ conversations: [] })
    },
  })

  await client.accountConversationInbox()
  expect(new URL(requests[0]!.url).search).toBe('')
  await client.accountConversationInbox({ includeArchived: true })
  expect(new URL(requests[1]!.url).search).toBe('?includeArchived=true')
})

test('looks an agent and a conversation up by stable id on account routes', async () => {
  const requests: Request[] = []
  const client = new AccountDirectoryApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      requests.push(new Request(`https://test${input}`, init))
      return Response.json({
        agent: page.agents[0],
        conversation: { id: '30000000-0000-4000-8000-000000000003' },
      })
    },
  })

  await client.accountAgent('10000000-0000-4000-8000-000000000001')
  await client.accountConversation('30000000-0000-4000-8000-000000000003')
  expect(new URL(requests[0]!.url).pathname).toBe(
    '/api/v1/account/agents/10000000-0000-4000-8000-000000000001'
  )
  expect(new URL(requests[1]!.url).pathname).toBe(
    '/api/v1/account/conversations/30000000-0000-4000-8000-000000000003'
  )
})
