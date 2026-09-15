import { beforeEach, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/solid-query'

import {
  devRuntimeQueryKeys,
  releaseDevRuntimeNodeCache,
  releaseDevRuntimeWorkspaceCache,
} from '../../src/dev-runtime'

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient()
})

const scope = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  runtimeNodeId: 'node-a',
} as const

test('Dev Runtime keys include account, workspace, and runtime node before private identity', () => {
  expect(devRuntimeQueryKeys.projects(scope)).toEqual([
    'dev-runtime',
    'account-a',
    'workspace-a',
    'node-a',
    'projects',
  ])
  expect(devRuntimeQueryKeys.session(scope, 'session-a')).toEqual([
    'dev-runtime',
    'account-a',
    'workspace-a',
    'node-a',
    'sessions',
    'session-a',
  ])
})

test('runtime-node release removes only the selected node cache', async () => {
  queryClient.setQueryData(devRuntimeQueryKeys.projects(scope), ['private-a'])
  queryClient.setQueryData(devRuntimeQueryKeys.projects({ ...scope, runtimeNodeId: 'node-b' }), [
    'private-b',
  ])
  queryClient.setQueryData(devRuntimeQueryKeys.projects({ ...scope, workspaceId: 'workspace-b' }), [
    'other-workspace',
  ])

  await releaseDevRuntimeNodeCache(queryClient, scope)

  expect(queryClient.getQueryData(devRuntimeQueryKeys.projects(scope))).toBeUndefined()
  expect(
    queryClient.getQueryData(devRuntimeQueryKeys.projects({ ...scope, runtimeNodeId: 'node-b' }))
  ).toEqual(['private-b'])
  expect(
    queryClient.getQueryData(devRuntimeQueryKeys.projects({ ...scope, workspaceId: 'workspace-b' }))
  ).toEqual(['other-workspace'])
})

test('workspace release removes all nodes but preserves sibling account and workspace caches', async () => {
  queryClient.setQueryData(devRuntimeQueryKeys.projects(scope), ['node-a'])
  queryClient.setQueryData(devRuntimeQueryKeys.projects({ ...scope, runtimeNodeId: 'node-b' }), [
    'node-b',
  ])
  queryClient.setQueryData(devRuntimeQueryKeys.projects({ ...scope, accountId: 'account-b' }), [
    'other-account',
  ])
  queryClient.setQueryData(devRuntimeQueryKeys.projects({ ...scope, workspaceId: 'workspace-b' }), [
    'other-workspace',
  ])

  await releaseDevRuntimeWorkspaceCache(queryClient, scope.accountId, scope.workspaceId)

  expect(queryClient.getQueryData(devRuntimeQueryKeys.projects(scope))).toBeUndefined()
  expect(
    queryClient.getQueryData(devRuntimeQueryKeys.projects({ ...scope, runtimeNodeId: 'node-b' }))
  ).toBeUndefined()
  expect(
    queryClient.getQueryData(devRuntimeQueryKeys.projects({ ...scope, accountId: 'account-b' }))
  ).toEqual(['other-account'])
  expect(
    queryClient.getQueryData(devRuntimeQueryKeys.projects({ ...scope, workspaceId: 'workspace-b' }))
  ).toEqual(['other-workspace'])
})
