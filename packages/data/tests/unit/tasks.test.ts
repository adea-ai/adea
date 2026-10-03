import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/solid-query'

import { taskMutationOptions, taskQueryKeys, taskQueryOptions } from '../../src'

const taskMoveInput = (taskId: string) => ({
  command: { expectedVersion: 1, idempotencyKey: taskId, requestId: taskId },
  taskId,
})

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
    const snapshot = await options.onMutate(input)
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', lifecycleState: 'queued', version: 1 },
      { id: 'task-2', lifecycleState: 'created', version: 1 },
    ])

    const pending = options.mutationFn(input)
    settle.resolve?.({ task: { id: 'task-1', lifecycleState: 'queued', version: 2 } })
    await options.onSuccess((await pending) as never, input, snapshot)
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

  test('a refused move preserves another card pending in the same workspace', async () => {
    const queryClient = new QueryClient()
    const listKey = taskQueryKeys.list('workspace-1')
    queryClient.setQueryData(listKey, [
      { id: 'task-1', lifecycleState: 'created', version: 1 },
      { id: 'task-2', lifecycleState: 'created', version: 1 },
    ])
    const options = taskMutationOptions.queue({} as never, queryClient, 'workspace-1')
    const first = await options.onMutate(taskMoveInput('task-1'))
    const second = await options.onMutate(taskMoveInput('task-2'))
    options.onError(new Error('refused'), taskMoveInput('task-1'), first)
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', lifecycleState: 'created', version: 1 },
      { id: 'task-2', lifecycleState: 'queued', version: 1 },
    ])
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false)
    await options.onSuccess(
      { task: { id: 'task-2', lifecycleState: 'queued', version: 2 } } as never,
      taskMoveInput('task-2'),
      second
    )
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', lifecycleState: 'created', version: 1 },
      { id: 'task-2', lifecycleState: 'queued', version: 2 },
    ])
  })

  test('same-card writes wait for the active version and a refusal restores the original row', async () => {
    const queryClient = new QueryClient()
    const listKey = taskQueryKeys.list('workspace-1')
    queryClient.setQueryData(listKey, [{ id: 'task-1', lifecycleState: 'created', version: 1 }])
    const options = taskMutationOptions.queue({} as never, queryClient, 'workspace-1')
    const input = {
      command: { expectedVersion: 1, idempotencyKey: 'move', requestId: 'move' },
      taskId: 'task-1',
    }
    const first = await options.onMutate(input)
    await expect(options.onMutate(input)).rejects.toThrow('already being updated')
    options.onError(new Error('second write refused before sending'), input, undefined)
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', lifecycleState: 'queued', version: 1 },
    ])
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false)
    options.onError(new Error('active write refused'), input, first)
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', lifecycleState: 'created', version: 1 },
    ])
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true)
    // A later attempt is allowed after the refusal; no stale pending token remains.
    const retry = await options.onMutate(input)
    await options.onSuccess(
      { task: { id: 'task-1', lifecycleState: 'queued', version: 2 } } as never,
      input,
      retry
    )
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', lifecycleState: 'queued', version: 2 },
    ])
  })

  test('the mutation lifecycle rejects an overlapping card write before calling the API', async () => {
    const queryClient = new QueryClient()
    const listKey = taskQueryKeys.list('workspace-1')
    const original = [{ id: 'task-1', lifecycleState: 'created', version: 1 }]
    queryClient.setQueryData(listKey, original)
    const detailKey = taskQueryKeys.detail('workspace-1', 'task-1')
    queryClient.setQueryData(detailKey, { task: original[0] })
    let calls = 0
    let rejectActive: ((reason: Error) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const client = {
      queueTask: () => {
        calls += 1
        return new Promise((_resolve, reject) => {
          rejectActive = reject
          markStarted?.()
        })
      },
    } as never
    const options = taskMutationOptions.queue(client, queryClient, 'workspace-1')
    const input = {
      command: { expectedVersion: 1, idempotencyKey: 'move', requestId: 'move' },
      taskId: 'task-1',
    }
    const first = queryClient.getMutationCache().build(queryClient, options)
    const pending = first.execute(input)
    // Attach the rejection handler before releasing the controlled API promise.
    const refused = pending.then(
      () => {
        throw new Error('The controlled server refusal unexpectedly succeeded')
      },
      (error: unknown) => error
    )
    await started
    const second = queryClient.getMutationCache().build(queryClient, options)
    await expect(second.execute(input)).rejects.toThrow('already being updated')
    expect(calls).toBe(1)
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', lifecycleState: 'queued', version: 1 },
    ])
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false)
    expect(rejectActive).toBeDefined()
    rejectActive?.(new Error('server refused'))
    const failure = await refused
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('server refused')
    expect(queryClient.getQueryData(listKey)).toEqual(original)
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true)
  })

  test('a failed write never restores over a newer authoritative row', async () => {
    const queryClient = new QueryClient()
    const listKey = taskQueryKeys.list('workspace-1')
    queryClient.setQueryData(listKey, [{ id: 'task-1', lifecycleState: 'created', version: 1 }])
    const options = taskMutationOptions.queue({} as never, queryClient, 'workspace-1')
    const input = {
      command: { expectedVersion: 1, idempotencyKey: 'move', requestId: 'move' },
      taskId: 'task-1',
    }
    const snapshot = await options.onMutate(input)
    const authoritative = [{ id: 'task-1', lifecycleState: 'completed', version: 3 }]
    queryClient.setQueryData(listKey, authoritative)
    options.onError(new Error('conflict'), input, snapshot)
    expect(queryClient.getQueryData(listKey)).toEqual(authoritative)
  })

  test('out-of-order successful responses cannot overwrite a newer task version', async () => {
    const queryClient = new QueryClient()
    const newer = { task: { id: 'task-1', lifecycleState: 'completed', version: 3 } }
    queryClient.setQueryData(taskQueryKeys.list('workspace-1'), [newer.task])
    queryClient.setQueryData(taskQueryKeys.detail('workspace-1', 'task-1'), newer)
    const options = taskMutationOptions.queue({} as never, queryClient, 'workspace-1')
    await options.onSuccess({
      task: { id: 'task-1', lifecycleState: 'queued', version: 2 },
    } as never)
    expect(queryClient.getQueryData(taskQueryKeys.list('workspace-1'))).toEqual([newer.task])
    expect(queryClient.getQueryData(taskQueryKeys.detail('workspace-1', 'task-1'))).toEqual(newer)
  })

  test('create success inserts its server card before returning and never duplicates it', async () => {
    const queryClient = new QueryClient()
    const listKey = taskQueryKeys.list('workspace-1')
    queryClient.setQueryData(listKey, [{ id: 'task-1', version: 1 }])
    const options = taskMutationOptions.create({} as never, queryClient, 'workspace-1')
    const result = { task: { id: 'task-2', title: 'New card', version: 1 } } as never
    await options.onSuccess(result)
    await options.onSuccess(result)
    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', version: 1 },
      { id: 'task-2', title: 'New card', version: 1 },
    ])
  })
})
