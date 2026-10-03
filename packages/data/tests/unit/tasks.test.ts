import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/solid-query'

import { taskMutationOptions, taskQueryKeys, taskQueryOptions } from '../../src'

describe('Task query contracts', () => {
  test('keeps list and detail caches workspace scoped', () => {
    const client = {} as never
    expect(taskQueryOptions.list(client, 'workspace-1').queryKey).toEqual(
      taskQueryKeys.list('workspace-1')
    )
    expect(taskQueryOptions.detail(client, 'workspace-1', 'task-1').queryKey).toEqual(
      taskQueryKeys.detail('workspace-1', 'task-1')
    )
  })

  test('invalidates Task caches after lifecycle mutations', async () => {
    const calls: unknown[] = []
    const client = {
      queueTask: async (...args: unknown[]) => {
        calls.push(args)
        return { task: { id: 'task-1', version: 2 } }
      },
    } as never
    const queryClient = new QueryClient()
    const options = taskMutationOptions.queue(client, queryClient, 'workspace-1')
    const result = await options.mutationFn({
      command: { expectedVersion: 1, idempotencyKey: 'queue', requestId: 'request' },
      taskId: 'task-1',
    })
    await options.onSuccess(result)
    expect(calls).toHaveLength(1)
    expect(queryClient.getQueryData(taskQueryKeys.detail('workspace-1', 'task-1'))).toEqual(result)
  })

  test('moves a Task to its new lane before the server answers', async () => {
    const settle: { resolve?: (value: unknown) => void } = {}
    const client = {
      queueTask: () => new Promise((resolve) => (settle.resolve = resolve)),
    } as never
    const queryClient = new QueryClient()
    const listKey = taskQueryKeys.list('workspace-1')
    queryClient.setQueryData(listKey, [
      { id: 'task-1', lifecycleState: 'created', version: 1 },
      { id: 'task-2', lifecycleState: 'created', version: 1 },
    ])
    const options = taskMutationOptions.queue(client, queryClient, 'workspace-1')
    const input = {
      command: { expectedVersion: 1, idempotencyKey: 'queue', requestId: 'request' },
      taskId: 'task-1',
    }
    await options.onMutate(input)
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', lifecycleState: 'queued', version: 1 },
      { id: 'task-2', lifecycleState: 'created', version: 1 },
    ])

    const pending = options.mutationFn(input)
    settle.resolve?.({ task: { id: 'task-1', lifecycleState: 'queued', version: 2 } })
    await options.onSuccess((await pending) as never)
    // The server's copy replaces the optimistic row without waiting for a refetch.
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', lifecycleState: 'queued', version: 2 },
      { id: 'task-2', lifecycleState: 'created', version: 1 },
    ])
  })

  test('puts a refused move back where it was', async () => {
    const queryClient = new QueryClient()
    const listKey = taskQueryKeys.list('workspace-1')
    const before = [{ id: 'task-1', lifecycleState: 'in_progress', priority: 'normal', version: 3 }]
    queryClient.setQueryData(listKey, before)
    const options = taskMutationOptions.complete({} as never, queryClient, 'workspace-1')
    const input = {
      command: { expectedVersion: 3, idempotencyKey: 'complete', requestId: 'request' },
      taskId: 'task-1',
    }
    const snapshot = await options.onMutate(input)
    expect(
      queryClient.getQueryData<{ lifecycleState: string }[]>(listKey)?.[0]?.lifecycleState
    ).toBe('completed')
    options.onError(new Error('conflict'), input, snapshot)
    expect(queryClient.getQueryData(listKey)).toEqual(before)
  })

  test('shows a priority change on the card immediately', async () => {
    const queryClient = new QueryClient()
    const listKey = taskQueryKeys.list('workspace-1')
    queryClient.setQueryData(listKey, [
      { id: 'task-1', kind: 'feature', priority: 'normal', title: 'Plan', version: 1 },
    ])
    const options = taskMutationOptions.update({} as never, queryClient, 'workspace-1')
    await options.onMutate({
      command: { expectedVersion: 1, idempotencyKey: 'update', requestId: 'request' },
      taskId: 'task-1',
      update: { priority: 'urgent' },
    })
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', kind: 'feature', priority: 'urgent', title: 'Plan', version: 1 },
    ])
  })
})
