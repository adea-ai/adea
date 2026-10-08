import { afterEach, expect, test } from 'bun:test'
import { workspaceStore } from '@adea-ai/state'
import { MutationObserver, QueryClient } from '@tanstack/solid-query'

import {
  channelMutationOptions,
  channelQueryKeys,
  messageMutationOptions,
  messageQueryKeys,
  readStateMutationOptions,
  readStateQueryKeys,
} from '../../src'

const workspaceId = 'audience-mutation-workspace'
const initialState = { ...workspaceStore.getState() }
afterEach(() => workspaceStore.setState(initialState, true))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('an accepted message response arriving after audience revocation cannot restore its body', async () => {
  const started = deferred<void>()
  const response = deferred<{ message: { id: string; channelId: string; bodyText: string } }>()
  const client = {
    createMessage: () => {
      started.resolve()
      return response.promise
    },
  } as never
  const queries = new QueryClient()
  const mutation = new MutationObserver(
    queries,
    messageMutationOptions.create(client, queries, workspaceId, 'channel')
  )
  const pending = mutation.mutate({ bodyText: 'REVOKED-BODY', idempotencyKey: 'message' })
  await started.promise
  workspaceStore.getState().invalidateConversationAudience(workspaceId)
  response.resolve({ message: { id: 'message', channelId: 'channel', bodyText: 'REVOKED-BODY' } })
  await pending
  expect(queries.getQueryData(messageQueryKeys.detail(workspaceId, 'message'))).toBeUndefined()
  queries.clear()
})

test('late channel and read-state mutations cannot recreate revoked cache entries', async () => {
  const channelStarted = deferred<void>()
  const readStarted = deferred<void>()
  const channelResponse = deferred<{ channel: { id: string; title: string } }>()
  const readResponse = deferred<{ readState: { channelId: string }[] }>()
  const client = {
    updateChannel: () => {
      channelStarted.resolve()
      return channelResponse.promise
    },
    markAllRead: () => {
      readStarted.resolve()
      return readResponse.promise
    },
  } as never
  const queries = new QueryClient()
  const channel = new MutationObserver(
    queries,
    channelMutationOptions.update(client, queries, workspaceId)
  )
  const read = new MutationObserver(
    queries,
    readStateMutationOptions.all(client, queries, workspaceId)
  )
  const channelPending = channel.mutate({
    channelId: 'channel',
    expectedVersion: 1,
    update: { title: 'REVOKED-TITLE' },
  })
  const readPending = read.mutate()
  await Promise.all([channelStarted.promise, readStarted.promise])
  workspaceStore.getState().invalidateConversationAudience(workspaceId)
  channelResponse.resolve({ channel: { id: 'channel', title: 'REVOKED-TITLE' } })
  readResponse.resolve({ readState: [{ channelId: 'channel' }] })
  await Promise.all([channelPending, readPending])
  expect(queries.getQueryData(channelQueryKeys.detail(workspaceId, 'channel'))).toBeUndefined()
  expect(queries.getQueryData(readStateQueryKeys.detail(workspaceId))).toBeUndefined()
  queries.clear()
})
