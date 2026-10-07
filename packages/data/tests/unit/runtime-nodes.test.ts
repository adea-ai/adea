import { expect, test } from 'bun:test'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { runtimeNodeQueryKeys, runtimeNodeQueryOptions } from '../../src/runtime-nodes'
import { queryKeysForEvent } from '../../src/events'

test('inventory keys isolate client, workspace, host and page within one invalidation group', () => {
  const first = {} as AgentHqApiClient
  const second = {} as AgentHqApiClient
  const key = runtimeNodeQueryOptions.nodes(first, 'w').queryKey
  expect(key.slice(0, 3)).toEqual(runtimeNodeQueryKeys.all('w'))
  expect(runtimeNodeQueryOptions.nodes(first, 'w').queryKey).toEqual(key)
  expect(runtimeNodeQueryOptions.nodes(second, 'w').queryKey).not.toEqual(key)
  expect(runtimeNodeQueryOptions.nodes(first, 'other').queryKey).not.toEqual(key)
  const connections = runtimeNodeQueryOptions.connections(first, 'w', 'node')
  expect(connections.queryKey).not.toEqual(key)
  expect(runtimeNodeQueryOptions.connections(first, 'w', 'other').queryKey).not.toEqual(
    connections.queryKey
  )
  expect(runtimeNodeQueryOptions.connections(first, 'w', 'node', 'next').queryKey).not.toEqual(
    connections.queryKey
  )
  for (const event of ['paired', 'proof_accepted', 'key_rotated', 'revoked'])
    expect(queryKeysForEvent('w', `runtime_node.${event}`)).toEqual([runtimeNodeQueryKeys.all('w')])
})

test('queries are opt-in, cancellable, not retained or automatically retried', async () => {
  const calls: unknown[][] = []
  const client = {
    listRuntimeNodes: async (...args: unknown[]) => {
      calls.push(args)
      return { nodes: [] }
    },
    listRuntimeNodeConnections: async (...args: unknown[]) => {
      calls.push(args)
      return {}
    },
  } as unknown as AgentHqApiClient
  const signal = new AbortController().signal
  expect(runtimeNodeQueryOptions.nodes(client, undefined).enabled).toBe(false)
  expect(runtimeNodeQueryOptions.connections(client, 'w', undefined).enabled).toBe(false)
  expect(runtimeNodeQueryOptions.nodes(client, 'w', false).enabled).toBe(false)
  const nodes = runtimeNodeQueryOptions.nodes(client, 'w')
  const connections = runtimeNodeQueryOptions.connections(client, 'w', 'node', 'next')
  await nodes.queryFn({ signal })
  await connections.queryFn({ signal })
  expect(calls).toEqual([
    ['w', signal],
    ['w', 'node', 'next', signal],
  ])
  for (const options of [nodes, connections]) {
    expect(options.retry).toBe(false)
    expect(options.gcTime).toBe(0)
    expect(options.refetchOnWindowFocus).toBe(false)
  }
})
