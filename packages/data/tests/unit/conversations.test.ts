import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/solid-query'

import {
  channelMutationOptions,
  channelQueryKeys,
  messageMutationOptions,
  messageQueryKeys,
} from '../../src'

describe('conversation query contracts', () => {
  test('creates a topic with its own retry identity and caches only its workspace', async () => {
    const received: unknown[] = []
    const client = {
      createDirectAgentTopic: async (...input: unknown[]) => {
        received.push(input)
        return { channel: { id: 'topic-1' } }
      },
    } as never
    const queryClient = new QueryClient()
    const options = channelMutationOptions.directTopic(client, queryClient, 'w')
    const input = { agentId: 'a', idempotencyKey: 'topic-request-1', title: 'Architecture' }
    const context = options.onMutate()
    const result = await options.mutationFn(input)
    await options.onSuccess(result, undefined, context)
    expect(received).toEqual([['w', input]])
    expect(queryClient.getQueryData(channelQueryKeys.detail('w', 'topic-1'))).toEqual(result)
    expect(queryClient.getQueryData(channelQueryKeys.detail('other', 'topic-1'))).toBeUndefined()
  })
  test('keeps Channel and Message caches workspace scoped', () => {
    expect(channelQueryKeys.list('w')).toEqual(['workspaces', 'w', 'channels', 'list'])
    expect(messageQueryKeys.list('w', 'c')).toEqual([
      'workspaces',
      'w',
      'channels',
      'c',
      'messages',
      'list',
    ])
  })

  test('invalidates one canonical Channel timeline after message creation', async () => {
    const client = {
      createMessage: async () => ({ message: { channelId: 'c', id: 'm' } }),
    } as never
    const queryClient = new QueryClient()
    const options = messageMutationOptions.create(client, queryClient, 'w', 'c')
    const context = options.onMutate()
    const result = await options.mutationFn({ bodyText: 'Hello', idempotencyKey: 'm' })
    await options.onSuccess(result, undefined, context)
    expect(queryClient.getQueryData(messageQueryKeys.detail('w', 'm'))).toEqual(result)
  })
})
