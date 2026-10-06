import { describe, expect, test } from 'bun:test'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { QueryClient } from '@tanstack/solid-query'

import { workspaceMutationOptions, workspaceQueryKeys, workspaceQueryOptions } from '../../src'

const workspace = {
  accent: null,
  id: 'workspace-1',
  logo: { kind: 'monogram' as const },
  name: 'My Adea',
  scene: 'home' as const,
  sortOrder: 0,
  updatedAt: '2026-08-25T00:00:00.000Z',
  version: 1,
}

function client(overrides: Partial<AgentHqApiClient> = {}) {
  return {
    bootstrapWorkspace: async () => ({
      activeWorkspace: workspace,
      principal: { temporary: true },
      workspaces: [workspace],
    }),
    claimTemporaryWorkspace: async () => ({ claimed: true as const }),
    createWorkspace: async () => ({ created: true, workspace }),
    getWorkspace: async () => ({ agents: [], tasks: [], workspace }),
    listWorkspaces: async () => [workspace],
    reopenWorkspace: async () => ({ workspace }),
    ...overrides,
  } as unknown as AgentHqApiClient
}

describe('workspace query contracts', () => {
  test('uses distinct stable keys for bootstrap, list, and detail queries', async () => {
    const api = client()

    expect(workspaceQueryOptions.bootstrap(api).queryKey).toEqual(['workspaces', 'bootstrap'])
    expect(workspaceQueryOptions.list(api).queryKey).toEqual(['workspaces', 'list'])
    expect(workspaceQueryOptions.detail(api, workspace.id).queryKey).toEqual([
      'workspaces',
      'detail',
      workspace.id,
    ])
    expect(await workspaceQueryOptions.detail(api, workspace.id).queryFn()).toEqual({
      agents: [],
      tasks: [],
      workspace,
    })
  })

  test('disables detail fetching until a workspace is selected', () => {
    expect(workspaceQueryOptions.detail(client()).enabled).toBe(false)
  })
})

describe('workspace mutation contracts', () => {
  test('creates a workspace and primes its detail cache', async () => {
    const queryClient = new QueryClient()
    const options = workspaceMutationOptions.create(client(), queryClient)
    const result = await options.mutationFn({ idempotencyKey: 'create-1', name: workspace.name })
    await options.onSuccess(result)

    expect(queryClient.getQueryData(workspaceQueryKeys.detail(workspace.id))).toEqual({
      agents: [],
      tasks: [],
      workspace,
    })
  })

  test('passes claim and reopen identifiers through their mutations', async () => {
    const calls: string[] = []
    const api = client({
      claimTemporaryWorkspace: async (credential) => {
        calls.push(`claim:${credential}`)
        return { claimed: true }
      },
      reopenWorkspace: async (workspaceId) => {
        calls.push(`reopen:${workspaceId}`)
        return { workspace }
      },
    })
    const queryClient = new QueryClient()

    const claim = workspaceMutationOptions.claim(api, queryClient)
    await claim.onSuccess(await claim.mutationFn('adea_tmp_example'))
    const reopen = workspaceMutationOptions.reopen(api, queryClient)
    await reopen.onSuccess(await reopen.mutationFn(workspace.id))

    expect(calls).toEqual(['claim:adea_tmp_example', `reopen:${workspace.id}`])
  })
})

function bootstrap(workspaces: readonly (typeof workspace)[]) {
  return {
    activeWorkspace: workspaces[0]!,
    principal: { temporary: true },
    sessionRotated: false,
    workspaces,
  }
}

describe('workspace identity mutations', () => {
  test('appends a created workspace to the bootstrap list without refetching it', async () => {
    const created = { ...workspace, id: 'workspace-2', name: 'Pink Binder', sortOrder: 1 }
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceQueryKeys.bootstrap, bootstrap([workspace]))
    const options = workspaceMutationOptions.create(
      client({ createWorkspace: async () => ({ created: true, workspace: created }) }),
      queryClient
    )
    await options.onSuccess(await options.mutationFn({ idempotencyKey: 'k', name: 'Pink Binder' }))
    await options.onSuccess({ created: false, workspace: created })

    const data = queryClient.getQueryData<ReturnType<typeof bootstrap>>(
      workspaceQueryKeys.bootstrap
    )
    expect(data?.workspaces.map(({ id }) => id)).toEqual(['workspace-1', 'workspace-2'])
    expect(queryClient.getQueryState(workspaceQueryKeys.bootstrap)?.isInvalidated).toBe(false)
  })

  test('sends the versioned update and patches both bootstrap copies', async () => {
    const renamed = { ...workspace, accent: 'pink' as const, name: 'Adea', version: 2 }
    const calls: unknown[] = []
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceQueryKeys.bootstrap, bootstrap([workspace]))
    const options = workspaceMutationOptions.update(
      client({
        updateWorkspace: async (workspaceId, input) => {
          calls.push([workspaceId, input])
          return { workspace: renamed }
        },
      }),
      queryClient
    )
    await options.onSuccess(
      await options.mutationFn({
        update: { accent: 'pink', expectedVersion: 1, name: 'Adea' },
        workspaceId: workspace.id,
      })
    )

    expect(calls).toEqual([[workspace.id, { accent: 'pink', expectedVersion: 1, name: 'Adea' }]])
    const data = queryClient.getQueryData<ReturnType<typeof bootstrap>>(
      workspaceQueryKeys.bootstrap
    )
    expect(data?.activeWorkspace).toEqual(renamed)
    expect(data?.workspaces).toEqual([renamed])
  })
})
