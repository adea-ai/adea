import { beforeEach, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

import { releaseWorkspaceCache } from '../../src'

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient()
})

test('releaseWorkspaceCache removes every cached entry for the outgoing workspace', () => {
  queryClient.setQueryData(['workspaces', 'workspace-work', 'rooms', 'list'], { rooms: [] })
  queryClient.setQueryData(['workspaces', 'workspace-work', 'agents', 'list'], [])
  queryClient.setQueryData(['workspaces', 'workspace-home', 'rooms', 'list'], [])
  queryClient.setQueryData(['workspaces', 'bootstrap'], { workspaces: [] })

  releaseWorkspaceCache(queryClient, 'workspace-work')

  expect(
    queryClient.getQueryData(['workspaces', 'workspace-work', 'rooms', 'list'])
  ).toBeUndefined()
  expect(
    queryClient.getQueryData(['workspaces', 'workspace-work', 'agents', 'list'])
  ).toBeUndefined()
  expect(queryClient.getQueryData(['workspaces', 'workspace-home', 'rooms', 'list'])).toBeDefined()
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
