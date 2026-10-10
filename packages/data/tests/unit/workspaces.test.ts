import { describe, expect, test } from 'bun:test'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { QueryClient } from '@tanstack/solid-query'

import {
  workspaceMutationOptions,
  workspaceDeleteMutationOptions,
  workspaceQueryKeys,
  workspaceQueryOptions,
} from '../../src'

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

describe('archived workspace discovery contract', () => {
  test('the archived listing has its own stable key and resolves the owner rows', async () => {
    const api = client({
      listArchivedWorkspaces: async () => ({ workspaces: [workspace] }),
    } as Partial<AgentHqApiClient>)

    expect(workspaceQueryOptions.archived(api).queryKey).toEqual(['workspaces', 'archived'])
    expect(await workspaceQueryOptions.archived(api).queryFn()).toEqual([workspace])
  })
})

describe('workspace archive contract', () => {
  test('archive removes the archived detail cache and refreshes every workspace query', async () => {
    const queryClient = new QueryClient()
    const archived: string[] = []
    queryClient.setQueryData(workspaceQueryKeys.detail(workspace.id), {
      agents: [],
      tasks: [],
      workspace,
    })
    const api = client({
      archiveWorkspace: async (workspaceId: string) => {
        archived.push(workspaceId)
        return { archived: true as const, workspaceId }
      },
    })
    const options = workspaceMutationOptions.archive(api, queryClient)

    await options.onSuccess(await options.mutationFn(workspace.id), workspace.id)

    expect(archived).toEqual([workspace.id])
    expect(queryClient.getQueryData(workspaceQueryKeys.detail(workspace.id))).toBeUndefined()
  })
})

describe('workspace identity mutations', () => {
  test('deletion removes every workspace cache and selects a remaining workspace; the last deletion stays empty', async () => {
    const queryClient = new QueryClient()
    const next = { ...workspace, id: 'workspace-next', name: 'Next' }
    queryClient.setQueryData(workspaceQueryKeys.bootstrap, bootstrap([workspace, next]))
    queryClient.setQueryData(workspaceQueryKeys.detail(workspace.id), { workspace })
    queryClient.setQueryData(['workspaces', workspace.id, 'messages', 'list'], ['private content'])
    queryClient.setQueryData(['workspaces', next.id, 'projects', 'list'], ['keep'])
    queryClient.setQueryData(
      ['dev-runtime', 'account', workspace.id, 'node', 'sessions'],
      ['private runtime']
    )
    queryClient.setQueryData(
      ['dev-runtime', 'account', next.id, 'node', 'sessions'],
      ['keep runtime']
    )
    const options = workspaceDeleteMutationOptions({} as AgentHqApiClient, queryClient)
    await options.onSuccess({ deleted: true, workspaceId: workspace.id, workspaces: [next] })
    expect(queryClient.getQueryData(workspaceQueryKeys.detail(workspace.id))).toBeUndefined()
    expect(
      queryClient.getQueryData(['workspaces', workspace.id, 'messages', 'list'])
    ).toBeUndefined()
    expect(queryClient.getQueryData(['workspaces', next.id, 'projects', 'list'])).toEqual(['keep'])
    expect(
      queryClient.getQueryData(['dev-runtime', 'account', workspace.id, 'node', 'sessions'])
    ).toBeUndefined()
    expect(
      queryClient.getQueryData(['dev-runtime', 'account', next.id, 'node', 'sessions'])
    ).toEqual(['keep runtime'])
    expect(queryClient.getQueryData(workspaceQueryKeys.bootstrap)).toMatchObject({
      activeWorkspace: next,
      workspaces: [next],
    })
    await options.onSuccess({ deleted: true, workspaceId: next.id, workspaces: [] })
    expect(queryClient.getQueryData(workspaceQueryKeys.bootstrap)).toMatchObject({
      activeWorkspace: null,
      workspaces: [],
    })
  })
  test('cancels an in-flight private read so its late response cannot restore deleted data', async () => {
    const queryClient = new QueryClient()
    const queryKey = ['workspaces', workspace.id, 'messages', 'pending']
    let finish: ((value: string) => void) | undefined
    const read = queryClient
      .fetchQuery({
        queryKey,
        queryFn: () =>
          new Promise<string>((resolve) => {
            finish = resolve
          }),
      })
      .catch(() => undefined)
    const options = workspaceDeleteMutationOptions({} as AgentHqApiClient, queryClient)
    await options.onSuccess({ deleted: true, workspaceId: workspace.id, workspaces: [] })
    finish!('private')
    await read
    expect(queryClient.getQueryData(queryKey)).toBeUndefined()
  })
  test('an older bootstrap response cannot put a deleted workspace back in the picker', async () => {
    const queryClient = new QueryClient()
    const next = { ...workspace, id: 'next' }
    queryClient.setQueryData(workspaceQueryKeys.bootstrap, bootstrap([workspace, next]))
    let finish: ((value: ReturnType<typeof bootstrap>) => void) | undefined
    const read = queryClient
      .fetchQuery({
        queryKey: workspaceQueryKeys.bootstrap,
        queryFn: () =>
          new Promise<ReturnType<typeof bootstrap>>((resolve) => {
            finish = resolve
          }),
      })
      .catch(() => undefined)
    const options = workspaceDeleteMutationOptions({} as AgentHqApiClient, queryClient)
    await options.onSuccess({ deleted: true, workspaceId: workspace.id, workspaces: [next] })
    finish!(bootstrap([workspace, next]))
    await read
    expect(queryClient.getQueryData(workspaceQueryKeys.bootstrap)).toMatchObject({
      activeWorkspace: next,
      workspaces: [next],
    })
  })
  test('deletion errors refresh the authoritative workspace confirmation and picker state', async () => {
    const queryClient = new QueryClient()
    for (const queryKey of [
      workspaceQueryKeys.bootstrap,
      workspaceQueryKeys.list,
      workspaceQueryKeys.detail(workspace.id),
    ])
      queryClient.setQueryData(queryKey, {})
    const options = workspaceDeleteMutationOptions({} as AgentHqApiClient, queryClient)
    await options.onError(new Error('Workspace version conflict'), { workspaceId: workspace.id })
    for (const queryKey of [
      workspaceQueryKeys.bootstrap,
      workspaceQueryKeys.list,
      workspaceQueryKeys.detail(workspace.id),
    ])
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true)
  })
  test('creating from an empty bootstrap selects the new workspace', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceQueryKeys.bootstrap, {
      ...bootstrap([]),
      activeWorkspace: null,
    })
    const options = workspaceMutationOptions.create(client(), queryClient)
    await options.onSuccess({ created: true, workspace })
    expect(queryClient.getQueryData(workspaceQueryKeys.bootstrap)).toMatchObject({
      activeWorkspace: workspace,
      workspaces: [workspace],
    })
  })
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

test('workspace reorder updates both list caches without changing the explicit active workspace', async () => {
  const queryClient = new QueryClient()
  const home = { ...workspace, id: 'home', isPersonal: true, canDelete: false }
  const secondary = { ...workspace, id: 'secondary', sortOrder: 1 }
  queryClient.setQueryData(workspaceQueryKeys.bootstrap, {
    ...bootstrap([home, secondary]),
    activeWorkspace: secondary,
  })
  const reordered = [
    { ...secondary, sortOrder: 0 },
    { ...home, sortOrder: 1 },
  ]
  const options = workspaceMutationOptions.reorder(
    client({ reorderWorkspaces: async () => reordered }),
    queryClient
  )
  await options.onSuccess(await options.mutationFn(['secondary', 'home']))
  expect(queryClient.getQueryData(workspaceQueryKeys.list)).toEqual(reordered)
  expect(queryClient.getQueryData(workspaceQueryKeys.bootstrap)).toMatchObject({
    workspaces: reordered,
    activeWorkspace: reordered[0],
  })
})
