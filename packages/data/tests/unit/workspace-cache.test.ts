import { beforeEach, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/solid-query'

import { accountQueryKeys, releaseWorkspaceCache } from '../../src'

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient()
})

test('releaseWorkspaceCache removes every cached entry for the outgoing workspace', () => {
  queryClient.setQueryData(['workspaces', 'workspace-work', 'projects', 'list'], { projects: [] })
  queryClient.setQueryData(['workspaces', 'workspace-work', 'agents', 'list'], [])
  queryClient.setQueryData(['workspaces', 'workspace-home', 'projects', 'list'], [])
  queryClient.setQueryData(['workspaces', 'bootstrap'], { workspaces: [] })

  releaseWorkspaceCache(queryClient, 'workspace-work')

  expect(
    queryClient.getQueryData(['workspaces', 'workspace-work', 'projects', 'list'])
  ).toBeUndefined()
  expect(
    queryClient.getQueryData(['workspaces', 'workspace-work', 'agents', 'list'])
  ).toBeUndefined()
  expect(
    queryClient.getQueryData(['workspaces', 'workspace-home', 'projects', 'list'])
  ).toBeDefined()
  expect(queryClient.getQueryData(['workspaces', 'bootstrap'])).toBeDefined()
})

test('releaseWorkspaceCache leaves no cached entries under the outgoing workspace key', () => {
  queryClient.setQueryData(['workspaces', 'workspace-work', 'channels', 'list'], [])
  queryClient.setQueryData(['workspaces', 'workspace-work', 'read-state'], { readState: [] })

  releaseWorkspaceCache(queryClient, 'workspace-work')

  expect(
    queryClient.getQueryCache().findAll({ queryKey: ['workspaces', 'workspace-work'] })
  ).toEqual([])
})

test('releaseWorkspaceCache is a no-op for a workspace with nothing cached', () => {
  expect(() => releaseWorkspaceCache(queryClient, 'workspace-unknown')).not.toThrow()
})

test('releaseWorkspaceCache keeps the account summary across workspace switches', () => {
  queryClient.setQueryData(accountQueryKeys.summary, { workspaces: [] })

  releaseWorkspaceCache(queryClient, 'workspace-work')

  expect(queryClient.getQueryData(accountQueryKeys.summary)).toEqual({ workspaces: [] })
})
