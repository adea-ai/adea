import type {
  AgentHqModelConnectionsClient,
  ApiModelDefaultsSetInput,
  ApiModelFundingBinding,
  ApiModelFundingView,
  ApiModelConnectionCreateInput,
  ApiModelConnectionRevokeInput,
} from '@adea-ai/api-client/model-connections'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/solid-query'

export const modelConnectionsQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'model-connections'] as const,
  list: (workspaceId: string) => [...modelConnectionsQueryKeys.all(workspaceId), 'list'] as const,
  defaults: (workspaceId: string) =>
    [...modelConnectionsQueryKeys.all(workspaceId), 'defaults'] as const,
  funding: (workspaceId: string, binding?: ApiModelFundingBinding) =>
    [
      ...modelConnectionsQueryKeys.all(workspaceId),
      'funding',
      binding?.executionId ?? '',
      binding?.attemptId ?? '',
      binding?.selectionRef ?? '',
      binding?.selectionRevision ?? 0,
    ] as const,
}

export const modelConnectionsQueryOptions = {
  list: (client: AgentHqModelConnectionsClient, workspaceId?: string, enabled = true) => ({
    queryKey: modelConnectionsQueryKeys.list(workspaceId ?? ''),
    queryFn: () => client.listModelConnections(workspaceId!),
    enabled: Boolean(workspaceId) && enabled,
    retry: false,
  }),
  defaults: (client: AgentHqModelConnectionsClient, workspaceId?: string, enabled = true) => ({
    queryKey: modelConnectionsQueryKeys.defaults(workspaceId ?? ''),
    queryFn: () => client.getWorkspaceModelDefaults(workspaceId!),
    enabled: Boolean(workspaceId) && enabled,
    retry: false,
  }),
  funding: (
    client: AgentHqModelConnectionsClient,
    workspaceId?: string,
    binding?: ApiModelFundingBinding,
    enabled = true
  ) => ({
    queryKey: modelConnectionsQueryKeys.funding(workspaceId ?? '', binding),
    queryFn: () => client.getModelSelectionFunding(workspaceId!, binding!),
    enabled: Boolean(workspaceId && binding) && enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  }),
}

export const modelConnectionsMutationOptions = {
  create: (
    client: AgentHqModelConnectionsClient,
    queryClient: QueryClient,
    workspaceId: string
  ) => ({
    mutationFn: (input: ApiModelConnectionCreateInput) =>
      client.createModelConnection(workspaceId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: modelConnectionsQueryKeys.all(workspaceId) })
    },
  }),
  revoke: (
    client: AgentHqModelConnectionsClient,
    queryClient: QueryClient,
    workspaceId: string
  ) => ({
    mutationFn: (input: ApiModelConnectionRevokeInput) =>
      client.revokeModelConnection(workspaceId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: modelConnectionsQueryKeys.all(workspaceId) })
    },
  }),
  setDefaults: (
    client: AgentHqModelConnectionsClient,
    queryClient: QueryClient,
    workspaceId: string
  ) => ({
    mutationFn: (input: ApiModelDefaultsSetInput) =>
      client.setWorkspaceModelDefaults(workspaceId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: modelConnectionsQueryKeys.all(workspaceId) })
    },
  }),
}

type Accessor<T> = () => T

export function useCreateModelConnectionMutation(
  client: AgentHqModelConnectionsClient,
  workspaceId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    modelConnectionsMutationOptions.create(client, queryClient, workspaceId())
  )
}

export function useRevokeModelConnectionMutation(
  client: AgentHqModelConnectionsClient,
  workspaceId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    modelConnectionsMutationOptions.revoke(client, queryClient, workspaceId())
  )
}

export function useModelConnectionsQuery(
  client: AgentHqModelConnectionsClient,
  workspaceId: Accessor<string | undefined>,
  enabled: Accessor<boolean> = () => true
) {
  return useQuery(() => modelConnectionsQueryOptions.list(client, workspaceId(), enabled()))
}

export function useWorkspaceModelDefaultsQuery(
  client: AgentHqModelConnectionsClient,
  workspaceId: Accessor<string | undefined>,
  enabled: Accessor<boolean> = () => true
) {
  return useQuery(() => modelConnectionsQueryOptions.defaults(client, workspaceId(), enabled()))
}

export function useModelSelectionFundingQuery(
  client: AgentHqModelConnectionsClient,
  workspaceId: Accessor<string | undefined>,
  binding: Accessor<ApiModelFundingBinding | undefined>,
  enabled: Accessor<boolean> = () => true
) {
  return useQuery(() =>
    modelConnectionsQueryOptions.funding(client, workspaceId(), binding(), enabled())
  )
}

export function useSetWorkspaceModelDefaultsMutation(
  client: AgentHqModelConnectionsClient,
  workspaceId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    modelConnectionsMutationOptions.setDefaults(client, queryClient, workspaceId())
  )
}

/** Expired ready disclosures are never displayed as current payer authority. */
export function currentModelFundingView(
  value: ApiModelFundingView,
  now = Date.now()
): ApiModelFundingView {
  if (value.state === 'blocked' || Date.parse(value.expiresAt) > now) return value
  return {
    schemaVersion: value.schemaVersion,
    workspaceId: value.workspaceId,
    executionId: value.executionId,
    attemptId: value.attemptId,
    selectionRef: value.selectionRef,
    selectionRevision: value.selectionRevision,
    state: 'blocked',
    reasonCode: 'READINESS_UNAVAILABLE',
  }
}
