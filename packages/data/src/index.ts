import type { AgentHqApiClient } from '@agent-hq/api-client'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export { AgentHqQueryProvider } from './provider'

export const workspaceQueryKeys = {
  all: ['workspaces'] as const,
  bootstrap: ['workspaces', 'bootstrap'] as const,
  detail: (workspaceId: string) => ['workspaces', 'detail', workspaceId] as const,
  list: ['workspaces', 'list'] as const,
}

export const roomQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'rooms'] as const,
  detail: (workspaceId: string, roomId: string) =>
    ['workspaces', workspaceId, 'rooms', 'detail', roomId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'rooms', 'list'] as const,
}

export const roomQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, roomId?: string) => ({
    queryKey: roomQueryKeys.detail(workspaceId ?? '', roomId ?? ''),
    queryFn: () => client.getRoom(workspaceId!, roomId!),
    enabled: Boolean(workspaceId && roomId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: roomQueryKeys.list(workspaceId ?? ''),
    queryFn: () => client.listRooms(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
}

export const roomMutationOptions = {
  archive: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (roomId: string) => client.archiveRoom(workspaceId, roomId),
    onSuccess: async (_result: unknown, roomId: string) => {
      queryClient.removeQueries({ queryKey: roomQueryKeys.detail(workspaceId, roomId) })
      await queryClient.invalidateQueries({ queryKey: roomQueryKeys.all(workspaceId) })
    },
  }),
  create: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createRoom']>[1]) =>
      client.createRoom(workspaceId, input),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['createRoom']>>) => {
      queryClient.setQueryData(roomQueryKeys.detail(workspaceId, result.room.id), result)
      await queryClient.invalidateQueries({ queryKey: roomQueryKeys.all(workspaceId) })
    },
  }),
  reorder: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (roomIds: readonly string[]) => client.reorderRooms(workspaceId, roomIds),
    onSuccess: (result: Awaited<ReturnType<AgentHqApiClient['reorderRooms']>>) => {
      queryClient.setQueryData(roomQueryKeys.list(workspaceId), result)
    },
  }),
  update: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ roomId: string; update: Parameters<AgentHqApiClient['updateRoom']>[2] }>
    ) => client.updateRoom(workspaceId, input.roomId, input.update),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['updateRoom']>>) => {
      queryClient.setQueryData(roomQueryKeys.detail(workspaceId, result.room.id), result)
      await queryClient.invalidateQueries({ queryKey: roomQueryKeys.list(workspaceId) })
    },
  }),
}

export const workspaceQueryOptions = {
  bootstrap: (client: AgentHqApiClient) => ({
    queryKey: workspaceQueryKeys.bootstrap,
    queryFn: () => client.bootstrapWorkspace(),
    staleTime: 30_000,
  }),
  detail: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: workspaceQueryKeys.detail(workspaceId ?? ''),
    queryFn: () => client.getWorkspace(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
  list: (client: AgentHqApiClient) => ({
    queryKey: workspaceQueryKeys.list,
    queryFn: () => client.listWorkspaces(),
  }),
}

export const workspaceMutationOptions = {
  claim: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (temporaryCredential: string) =>
      client.claimTemporaryWorkspace(temporaryCredential),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all })
    },
  }),
  create: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createWorkspace']>[0]) =>
      client.createWorkspace(input),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['createWorkspace']>>) => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all })
      queryClient.setQueryData(workspaceQueryKeys.detail(result.workspace.id), {
        workspace: result.workspace,
        agents: [],
        tasks: [],
      })
    },
  }),
  reopen: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (workspaceId: string) => client.reopenWorkspace(workspaceId),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['reopenWorkspace']>>) => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all })
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.detail(result.workspace.id),
      })
    },
  }),
}

export function useWorkspaceBootstrapQuery(client: AgentHqApiClient) {
  return useQuery(workspaceQueryOptions.bootstrap(client))
}

export function useWorkspaceListQuery(client: AgentHqApiClient) {
  return useQuery(workspaceQueryOptions.list(client))
}

export function useWorkspaceQuery(client: AgentHqApiClient, workspaceId?: string) {
  return useQuery(workspaceQueryOptions.detail(client, workspaceId))
}

export function useCreateWorkspaceMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient()
  return useMutation(workspaceMutationOptions.create(client, queryClient))
}

export function useReopenWorkspaceMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient()
  return useMutation(workspaceMutationOptions.reopen(client, queryClient))
}

export function useClaimTemporaryWorkspaceMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient()
  return useMutation(workspaceMutationOptions.claim(client, queryClient))
}

export function useRoomListQuery(client: AgentHqApiClient, workspaceId?: string) {
  return useQuery(roomQueryOptions.list(client, workspaceId))
}

export function useRoomQuery(client: AgentHqApiClient, workspaceId?: string, roomId?: string) {
  return useQuery(roomQueryOptions.detail(client, workspaceId, roomId))
}

export function useCreateRoomMutation(client: AgentHqApiClient, workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation(roomMutationOptions.create(client, queryClient, workspaceId))
}

export function useUpdateRoomMutation(client: AgentHqApiClient, workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation(roomMutationOptions.update(client, queryClient, workspaceId))
}

export function useArchiveRoomMutation(client: AgentHqApiClient, workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation(roomMutationOptions.archive(client, queryClient, workspaceId))
}

export function useReorderRoomsMutation(client: AgentHqApiClient, workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation(roomMutationOptions.reorder(client, queryClient, workspaceId))
}
