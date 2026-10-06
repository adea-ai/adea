import type {
  AgentHqApiClient,
  ApiCatalogLifecycleInput,
  ApiCloudConnectionCreateInput,
  ApiCloudConnectionRotateInput,
  ApiSkillPublishInput,
} from '@adea-ai/api-client'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/solid-query'

/**
 * Workspace Skills and Cloud connections (ADR 0013), served by the Control
 * Plane through Adea's workspace routes. Keys sit under the workspace prefix
 * so leaving a workspace releases them with the rest of its cache. Every
 * mutation mints its own idempotency key unless the caller supplies one, and
 * refreshes the list it changed.
 *
 * Cloud connection secrets pass through `mutationFn` once and are never part
 * of a query key, cached result or invalidation.
 */
export const controlPlaneQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'control-plane'] as const,
  agentProfiles: (workspaceId: string) =>
    ['workspaces', workspaceId, 'control-plane', 'agent-profiles'] as const,
  cloudConnections: (workspaceId: string) =>
    ['workspaces', workspaceId, 'control-plane', 'cloud-connections'] as const,
  skills: (workspaceId: string) => ['workspaces', workspaceId, 'control-plane', 'skills'] as const,
}

/** A fresh key per user action; retries of that action reuse it. */
export function controlPlaneIdempotencyKey(): string {
  return `adea-${crypto.randomUUID()}`
}

export const controlPlaneQueryOptions = {
  agentProfiles: (client: AgentHqApiClient, workspaceId?: string, enabled = true) => ({
    enabled: Boolean(workspaceId) && enabled,
    queryFn: () => client.listWorkspaceAgentProfiles(workspaceId!),
    queryKey: controlPlaneQueryKeys.agentProfiles(workspaceId ?? ''),
    retry: false,
  }),
  cloudConnections: (client: AgentHqApiClient, workspaceId?: string, enabled = true) => ({
    enabled: Boolean(workspaceId) && enabled,
    queryFn: () => client.listCloudConnections(workspaceId!),
    queryKey: controlPlaneQueryKeys.cloudConnections(workspaceId ?? ''),
    retry: false,
  }),
  skills: (client: AgentHqApiClient, workspaceId?: string, enabled = true) => ({
    enabled: Boolean(workspaceId) && enabled,
    queryFn: () => client.listWorkspaceSkills(workspaceId!),
    queryKey: controlPlaneQueryKeys.skills(workspaceId ?? ''),
    retry: false,
  }),
}

type WithOptionalKey<T extends { idempotencyKey: string }> = Omit<T, 'idempotencyKey'> &
  Readonly<{ idempotencyKey?: string }>

export type CatalogLifecycleVariables = Readonly<{
  kind: 'profile' | 'skill'
  id: string
  action: 'deprecate' | 'revoke'
  input: WithOptionalKey<ApiCatalogLifecycleInput>
}>

export const controlPlaneMutationOptions = {
  changeCatalogLifecycle: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string
  ) => ({
    mutationFn: (variables: CatalogLifecycleVariables) =>
      client.changeWorkspaceCatalogLifecycle(
        workspaceId,
        { action: variables.action, id: variables.id, kind: variables.kind },
        {
          ...variables.input,
          idempotencyKey: variables.input.idempotencyKey ?? controlPlaneIdempotencyKey(),
        }
      ),
    onSuccess: async (_data: unknown, variables: CatalogLifecycleVariables) => {
      await queryClient.invalidateQueries({
        queryKey:
          variables.kind === 'profile'
            ? controlPlaneQueryKeys.agentProfiles(workspaceId)
            : controlPlaneQueryKeys.skills(workspaceId),
      })
    },
  }),
  createCloudConnection: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string
  ) => ({
    // The variables carry the write-only secret: drop the finished mutation
    // from the cache at once instead of keeping it for the default window.
    gcTime: 0,
    mutationFn: (input: WithOptionalKey<ApiCloudConnectionCreateInput>) =>
      client.createCloudConnection(workspaceId, {
        ...input,
        idempotencyKey: input.idempotencyKey ?? controlPlaneIdempotencyKey(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: controlPlaneQueryKeys.cloudConnections(workspaceId),
      })
    },
  }),
  publishSkill: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: WithOptionalKey<ApiSkillPublishInput>) =>
      client.publishWorkspaceSkill(workspaceId, {
        ...input,
        idempotencyKey: input.idempotencyKey ?? controlPlaneIdempotencyKey(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.skills(workspaceId) })
    },
  }),
  revokeCloudConnection: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string
  ) => ({
    mutationFn: (variables: Readonly<{ credentialId: string; idempotencyKey?: string }>) =>
      client.revokeCloudConnection(workspaceId, variables.credentialId, {
        idempotencyKey: variables.idempotencyKey ?? controlPlaneIdempotencyKey(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: controlPlaneQueryKeys.cloudConnections(workspaceId),
      })
    },
  }),
  rotateCloudConnection: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string
  ) => ({
    // The variables carry the write-only secret: drop the finished mutation
    // from the cache at once instead of keeping it for the default window.
    gcTime: 0,
    mutationFn: (
      variables: Readonly<{
        credentialId: string
        input: WithOptionalKey<ApiCloudConnectionRotateInput>
      }>
    ) =>
      client.rotateCloudConnection(workspaceId, variables.credentialId, {
        ...variables.input,
        idempotencyKey: variables.input.idempotencyKey ?? controlPlaneIdempotencyKey(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: controlPlaneQueryKeys.cloudConnections(workspaceId),
      })
    },
  }),
}

type Accessor<T> = () => T

export function useWorkspaceSkillsQuery(
  client: AgentHqApiClient,
  workspaceId: Accessor<string | undefined>
) {
  return useQuery(() => controlPlaneQueryOptions.skills(client, workspaceId()))
}

export function useWorkspaceAgentProfilesQuery(
  client: AgentHqApiClient,
  workspaceId: Accessor<string | undefined>
) {
  return useQuery(() => controlPlaneQueryOptions.agentProfiles(client, workspaceId()))
}

export function useCloudConnectionsQuery(
  client: AgentHqApiClient,
  workspaceId: Accessor<string | undefined>
) {
  return useQuery(() => controlPlaneQueryOptions.cloudConnections(client, workspaceId()))
}

export function useCatalogLifecycleMutation(
  client: AgentHqApiClient,
  workspaceId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    controlPlaneMutationOptions.changeCatalogLifecycle(client, queryClient, workspaceId())
  )
}

export function usePublishSkillMutation(client: AgentHqApiClient, workspaceId: Accessor<string>) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    controlPlaneMutationOptions.publishSkill(client, queryClient, workspaceId())
  )
}

export function useCreateCloudConnectionMutation(
  client: AgentHqApiClient,
  workspaceId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    controlPlaneMutationOptions.createCloudConnection(client, queryClient, workspaceId())
  )
}

export function useRotateCloudConnectionMutation(
  client: AgentHqApiClient,
  workspaceId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    controlPlaneMutationOptions.rotateCloudConnection(client, queryClient, workspaceId())
  )
}

export function useRevokeCloudConnectionMutation(
  client: AgentHqApiClient,
  workspaceId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    controlPlaneMutationOptions.revokeCloudConnection(client, queryClient, workspaceId())
  )
}
