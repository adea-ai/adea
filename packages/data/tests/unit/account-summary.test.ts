import { expect, test } from 'bun:test'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { QueryClient } from '@tanstack/solid-query'

import {
  ACCOUNT_SUMMARY_REFETCH_INTERVAL_MS,
  accountQueryKeys,
  accountQueryOptions,
  readStateMutationOptions,
} from '../../src'

const summary = {
  workspaces: [{ mentions: 2, unreadChannels: 3, workspaceId: 'workspace-home' }],
}

test('polls the account summary outside the per-workspace key prefix', async () => {
  let calls = 0
  const client = {
    accountSummary: async () => {
      calls += 1
      return summary
    },
  } as unknown as AgentHqApiClient
  const options = accountQueryOptions.summary(client)

  expect(options.queryKey).toEqual(['account', 'summary'])
  expect(options.refetchInterval).toBe(ACCOUNT_SUMMARY_REFETCH_INTERVAL_MS)
  expect(ACCOUNT_SUMMARY_REFETCH_INTERVAL_MS).toBe(60_000)
  expect(options.refetchOnWindowFocus).toBe(true)
  expect(await options.queryFn()).toEqual(summary)
  expect(calls).toBe(1)
})

test('a read-state mutation refreshes the account summary', async () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(accountQueryKeys.summary, summary)
  const client = {
    markAllRead: async () => ({ readState: [] }),
  } as unknown as AgentHqApiClient
  const options = readStateMutationOptions.all(client, queryClient, 'workspace-home')

  const context = options.onMutate()
  options.onSuccess(await options.mutationFn(), undefined, context)

  expect(queryClient.getQueryState(accountQueryKeys.summary)?.isInvalidated).toBe(true)
  expect(queryClient.getQueryData(['workspaces', 'workspace-home', 'read-state'])).toEqual({
    readState: [],
  })
})
