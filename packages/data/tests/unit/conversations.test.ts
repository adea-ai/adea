import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

import { channelQueryKeys, messageMutationOptions, messageQueryKeys } from '../../src'

describe('conversation query contracts', () => {
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
    const result = await options.mutationFn({ bodyText: 'Hello', idempotencyKey: 'm' })
    await options.onSuccess(result)
    expect(queryClient.getQueryData(messageQueryKeys.detail('w', 'm'))).toEqual(result)
  })
})
