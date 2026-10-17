import { expect, test } from 'bun:test'
import type { AgentHqApiClient, ApiRuntimeNodeConnectionsResponse } from '@adea-ai/api-client'
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

test('connection query preserves independent health, freshness, grant and unknown upstream signals', async () => {
  const response: ApiRuntimeNodeConnectionsResponse = {
    node: {
      id: 'node',
      controlPlaneRuntimeNodeRefId: 'rnr_node',
      kind: 'remote_host',
      displayName: 'Home server',
      health: 'healthy',
      pairingState: 'paired',
      lastProofAt: '2026-10-07T06:00:00.000Z',
      deviceOnline: { state: 'not_applicable' },
      hostReachability: {
        state: 'unknown',
        dependency: 'control_plane.runtime_connection_discovery.host_reachability',
      },
    },
    discovery: { state: 'available' },
    controlPlaneReadiness: {
      state: 'unknown',
      dependency: 'control_plane.runtime_connection_discovery.readiness',
    },
    connections: [
      {
        id: 'connection',
        runtimeDefinitionId: 'definition',
        family: 'pi',
        connectionType: 'managed_local',
        location: 'remote_host',
        status: 'degraded',
        node: {
          runtimeNodeRefId: 'rnr_node',
          location: 'remote_host',
          status: 'online',
          health: 'online',
          deviceOnline: { state: 'not_applicable' },
          hostReachability: {
            state: 'unknown',
            dependency: 'control_plane.runtime_connection_discovery.host_reachability',
          },
          observedAt: '2026-10-07T06:00:00.000Z',
        },
        connection: { status: 'degraded', health: 'degraded', availability: 'stale' },
        freshness: { state: 'stale', observedAt: '2026-10-07T06:00:00.000Z' },
        versions: { adapter: '1', driver: '1', harness: '1' },
        capabilities: [],
        capabilityDetails: [],
        compatibility: { state: 'incompatible', limitations: [] },
        access: {
          localProjectGrant: { required: true, state: 'missing' },
          entitlement: { state: 'unknown' },
        },
        eligibility: { state: 'ineligible', reasons: [], degradations: [], remediation: [] },
        transport: {
          state: 'unknown',
          dependency: 'control_plane.runtime_connection_discovery.transport',
        },
        sessionOperations: {
          state: 'unknown',
          dependency: 'control_plane.runtime_connection_discovery.session_operations',
        },
        observedAt: '2026-10-07T06:00:00.000Z',
        limitations: [],
      },
    ],
    observedAt: '2026-10-07T06:00:00.000Z',
  }
  const client = {
    listRuntimeNodeConnections: async () => response,
  } as unknown as AgentHqApiClient
  const options = runtimeNodeQueryOptions.connections(client, 'workspace', 'node')

  await expect(options.queryFn({ signal: new AbortController().signal })).resolves.toEqual(response)
})
