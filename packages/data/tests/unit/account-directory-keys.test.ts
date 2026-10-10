import { expect, test } from 'bun:test'
import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import { QueryClient } from '@tanstack/solid-query'

import { accountQueryKeys, accountQueryOptions, releaseWorkspaceCache } from '../../src'

const page = { agents: [], conversations: [] }

function directoryClient(calls: string[]) {
  return {
    accountAgentDirectory: async (input: unknown) => {
      calls.push(`directory:${JSON.stringify(input)}`)
      return { agents: [] }
    },
    accountConversationInbox: async (input: unknown) => {
      calls.push(`inbox:${JSON.stringify(input)}`)
      return { conversations: [] }
    },
  } as unknown as AccountDirectoryApiClient
}

test('directory and inbox keys sit outside the per-workspace prefix', () => {
  expect(accountQueryKeys.all).toEqual(['account'])
  expect(accountQueryKeys.directory()).toEqual(['account', 'directory', {}])
  expect(accountQueryKeys.directory({ limit: 25 })).toEqual(['account', 'directory', { limit: 25 }])
  expect(accountQueryKeys.inbox({ after: 'cursor' })).toEqual([
    'account',
    'inbox',
    { after: 'cursor' },
  ])
  // The page input is part of the key: two pages never share one entry.
  expect(accountQueryKeys.directory({ limit: 25 })).not.toEqual(
    accountQueryKeys.directory({ limit: 50 })
  )
})

test('a workspace switch keeps cached directory and inbox pages', () => {
  const queryClient = new QueryClient()
  const directoryKey = accountQueryKeys.directory({ limit: 25 })
  const inboxKey = accountQueryKeys.inbox()
  queryClient.setQueryData(directoryKey, page)
  queryClient.setQueryData(inboxKey, { conversations: [] })
  queryClient.setQueryData(['workspaces', 'workspace-work', 'agents', 'list'], [])

  // Switching the selected workspace releases that workspace's cache only.
  releaseWorkspaceCache(queryClient, 'workspace-work')

  expect(queryClient.getQueryData(directoryKey)).toEqual(page)
  expect(queryClient.getQueryData(inboxKey)).toEqual({ conversations: [] })
  expect(
    queryClient.getQueryData(['workspaces', 'workspace-work', 'agents', 'list'])
  ).toBeUndefined()
})

test('query options read the directory and inbox through the account client', async () => {
  const calls: string[] = []
  const client = directoryClient(calls)

  const directory = accountQueryOptions.directory(client, { limit: 25 })
  expect(directory.queryKey).toEqual(accountQueryKeys.directory({ limit: 25 }))
  expect(await directory.queryFn()).toEqual({ agents: [] })

  const inbox = accountQueryOptions.inbox(client)
  expect(inbox.queryKey).toEqual(accountQueryKeys.inbox())
  expect(await inbox.queryFn()).toEqual({ conversations: [] })

  expect(calls).toEqual(['directory:{"limit":25}', 'inbox:{}'])
})
