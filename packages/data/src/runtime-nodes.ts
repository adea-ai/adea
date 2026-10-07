import type { AgentHqApiClient } from '@adea-ai/api-client'
import { useQuery } from '@tanstack/solid-query'

const clientIds = new WeakMap<AgentHqApiClient, number>()
let nextClientId = 0
function clientId(client: AgentHqApiClient): number {
  let id = clientIds.get(client)
  if (id === undefined) {
    id = ++nextClientId
    clientIds.set(client, id)
  }
  return id
}

export const runtimeNodeQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'runtime-nodes'] as const,
}

// The inspector mounts only while its tab is open. No polling or focus-triggered
// SDK calls; explicit refresh and committed node events reconcile the inventory.
const readOptions = { gcTime: 0, retry: false, refetchOnWindowFocus: false } as const
export const runtimeNodeQueryOptions = {
  nodes: (client: AgentHqApiClient, workspaceId?: string, enabled = true) => ({
    ...readOptions,
    enabled: Boolean(workspaceId) && enabled,
    queryKey: [...runtimeNodeQueryKeys.all(workspaceId ?? ''), clientId(client), 'list'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => client.listRuntimeNodes(workspaceId!, signal),
  }),
  connections: (
    client: AgentHqApiClient,
    workspaceId?: string,
    nodeId?: string,
    cursor?: string,
    enabled = true
  ) => ({
    ...readOptions,
    enabled: Boolean(workspaceId && nodeId) && enabled,
    queryKey: [
      ...runtimeNodeQueryKeys.all(workspaceId ?? ''),
      clientId(client),
      'connections',
      nodeId ?? '',
      cursor ?? '',
    ] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      client.listRuntimeNodeConnections(workspaceId!, nodeId!, cursor, signal),
  }),
}

export function useRuntimeNodesQuery(client: AgentHqApiClient, workspaceId: () => string) {
  return useQuery(() => runtimeNodeQueryOptions.nodes(client, workspaceId()))
}

export function useRuntimeNodeConnectionsQuery(
  client: AgentHqApiClient,
  workspaceId: () => string,
  nodeId: () => string | undefined,
  cursor: () => string | undefined
) {
  return useQuery(() =>
    runtimeNodeQueryOptions.connections(client, workspaceId(), nodeId(), cursor())
  )
}
