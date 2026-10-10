import { describe, expect, test } from 'bun:test'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { QueryClient } from '@tanstack/solid-query'

import { projectMutationOptions, projectQueryKeys, projectQueryOptions } from '../../src'

const project = {
  createdAt: '2026-08-30T00:00:00.000Z',
  iconKey: 'engineering',
  id: 'project-1',
  lifecycleState: 'active' as const,
  name: 'Engineering',
  sortOrder: 0,
  updatedAt: '2026-08-30T00:00:00.000Z',
  workspaceId: 'workspace-1',
}

function client(overrides: Partial<AgentHqApiClient> = {}) {
  return {
    archiveProject: async () => ({ archived: true as const }),
    createProject: async () => ({ project }),
    getProject: async () => ({ project }),
    listProjects: async () => [project],
    reorderProjects: async () => [project],
    updateProject: async () => ({ project }),
    ...overrides,
  } as unknown as AgentHqApiClient
}

describe('project query contracts', () => {
  test('uses stable workspace-scoped list and detail keys', async () => {
    const api = client()
    expect(projectQueryOptions.list(api, 'workspace-1').queryKey).toEqual([
      'workspaces',
      'workspace-1',
      'projects',
      'list',
    ])
    expect(projectQueryOptions.detail(api, 'workspace-1', 'project-1').queryKey).toEqual([
      'workspaces',
      'workspace-1',
      'projects',
      'detail',
      'project-1',
    ])
    expect(await projectQueryOptions.detail(api, 'workspace-1', 'project-1').queryFn()).toEqual({
      project,
    })
  })

  test('promotes through the revisioned restore mutation and seeds the detail cache', async () => {
    const calls: Array<{ input: unknown; projectId: string }> = []
    const queryClient = new QueryClient()
    const restored = { ...project, version: 8 }
    const api = client({
      restoreProject: (async (_workspaceId: string, projectId: string, input: unknown) => {
        calls.push({ input, projectId })
        return { project: restored }
      }) as unknown as AgentHqApiClient['restoreProject'],
    })
    const options = projectMutationOptions.restore(api, queryClient, 'workspace-1')
    const result = await options.mutationFn({
      input: { confirmed: true, expectedVersion: 7 },
      projectId: 'project-1',
    })
    expect(calls).toEqual([
      { input: { confirmed: true, expectedVersion: 7 }, projectId: 'project-1' },
    ])
    await options.onSuccess(result, { projectId: 'project-1' })
    expect(queryClient.getQueryData(projectQueryKeys.detail('workspace-1', 'project-1'))).toEqual(
      result
    )
  })
})

describe('project mutation contracts', () => {
  test('invalidates the workspace project collection after creation', async () => {
    const queryClient = new QueryClient()
    await queryClient.setQueryData(projectQueryKeys.list('workspace-1'), [project])
    const options = projectMutationOptions.create(client(), queryClient, 'workspace-1')
    const result = await options.mutationFn({ iconKey: 'engineering', name: 'Engineering' })
    await options.onSuccess(result)
    expect(queryClient.getQueryState(projectQueryKeys.list('workspace-1'))?.isInvalidated).toBe(
      true
    )
    expect(queryClient.getQueryData(projectQueryKeys.detail('workspace-1', project.id))).toEqual({
      project,
    })
  })
})
