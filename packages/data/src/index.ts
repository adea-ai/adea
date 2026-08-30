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

export const agentQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'agents'] as const,
  detail: (workspaceId: string, agentId: string) =>
    ['workspaces', workspaceId, 'agents', 'detail', agentId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'agents', 'list'] as const,
}

export const taskQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'tasks'] as const,
  detail: (workspaceId: string, taskId: string) =>
    ['workspaces', workspaceId, 'tasks', 'detail', taskId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'tasks', 'list'] as const,
}
export const taskQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, taskId?: string) => ({
    queryKey: taskQueryKeys.detail(workspaceId ?? '', taskId ?? ''),
    queryFn: () => client.getTask(workspaceId!, taskId!),
    enabled: Boolean(workspaceId && taskId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: taskQueryKeys.list(workspaceId ?? ''),
    queryFn: () => client.listTasks(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
}

function taskMutationSuccess(queryClient: QueryClient, workspaceId: string) {
  return async (result: Awaited<ReturnType<AgentHqApiClient['getTask']>>) => {
    queryClient.setQueryData(taskQueryKeys.detail(workspaceId, result.task.id), result)
    await queryClient.invalidateQueries({ queryKey: taskQueryKeys.list(workspaceId) })
  }
}

export const taskMutationOptions = {
  archive: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ command: Parameters<AgentHqApiClient['archiveTask']>[2]; taskId: string }>
    ) => client.archiveTask(workspaceId, input.taskId, input.command),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  artifacts: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        artifactRefs: readonly string[]
        command: Parameters<AgentHqApiClient['setTaskArtifactReferences']>[3]
        taskId: string
      }>
    ) =>
      client.setTaskArtifactReferences(
        workspaceId,
        input.taskId,
        input.artifactRefs,
        input.command
      ),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  assign: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        agentId: string | null
        command: Parameters<AgentHqApiClient['assignTask']>[3]
        taskId: string
      }>
    ) => client.assignTask(workspaceId, input.taskId, input.agentId, input.command),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  cancel: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ command: Parameters<AgentHqApiClient['cancelTask']>[2]; taskId: string }>
    ) => client.cancelTask(workspaceId, input.taskId, input.command),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  conversation: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        command: Parameters<AgentHqApiClient['setTaskConversationReferences']>[3]
        conversation: Parameters<AgentHqApiClient['setTaskConversationReferences']>[2]
        taskId: string
      }>
    ) =>
      client.setTaskConversationReferences(
        workspaceId,
        input.taskId,
        input.conversation,
        input.command
      ),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  create: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        command: Parameters<AgentHqApiClient['createTask']>[2]
        task: Parameters<AgentHqApiClient['createTask']>[1]
      }>
    ) => client.createTask(workspaceId, input.task, input.command),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  dependencies: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        command: Parameters<AgentHqApiClient['setTaskDependencies']>[3]
        dependencyIds: readonly string[]
        taskId: string
      }>
    ) => client.setTaskDependencies(workspaceId, input.taskId, input.dependencyIds, input.command),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  moveRoom: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        command: Parameters<AgentHqApiClient['moveTaskToRoom']>[3]
        roomId: string | null
        taskId: string
      }>
    ) => client.moveTaskToRoom(workspaceId, input.taskId, input.roomId, input.command),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  queue: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ command: Parameters<AgentHqApiClient['queueTask']>[2]; taskId: string }>
    ) => client.queueTask(workspaceId, input.taskId, input.command),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  update: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        command: Parameters<AgentHqApiClient['updateTask']>[3]
        taskId: string
        update: Parameters<AgentHqApiClient['updateTask']>[2]
      }>
    ) => client.updateTask(workspaceId, input.taskId, input.update, input.command),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
}
export const agentQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, agentId?: string) => ({
    queryKey: agentQueryKeys.detail(workspaceId ?? '', agentId ?? ''),
    queryFn: () => client.getAgent(workspaceId!, agentId!),
    enabled: Boolean(workspaceId && agentId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: agentQueryKeys.list(workspaceId ?? ''),
    queryFn: () => client.listAgents(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
}
export const agentMutationOptions = {
  assignRoom: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Readonly<{ agentId: string; roomId: string | null }>) =>
      client.assignAgentToRoom(workspaceId, input.agentId, input.roomId),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['assignAgentToRoom']>>) => {
      queryClient.setQueryData(agentQueryKeys.detail(workspaceId, result.agent.id), result)
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list(workspaceId) })
    },
  }),
  create: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createAgent']>[1]) =>
      client.createAgent(workspaceId, input),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['createAgent']>>) => {
      queryClient.setQueryData(agentQueryKeys.detail(workspaceId, result.agent.id), result)
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.all(workspaceId) })
    },
  }),
  archive: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (agentId: string) => client.archiveAgent(workspaceId, agentId),
    onSuccess: async (_result: unknown, agentId: string) => {
      queryClient.removeQueries({ queryKey: agentQueryKeys.detail(workspaceId, agentId) })
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.all(workspaceId) })
    },
  }),
  profile: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        agentId: string
        profile: Parameters<AgentHqApiClient['changeAgentProfile']>[2]
      }>
    ) => client.changeAgentProfile(workspaceId, input.agentId, input.profile),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['changeAgentProfile']>>) => {
      queryClient.setQueryData(agentQueryKeys.detail(workspaceId, result.agent.id), result)
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list(workspaceId) })
    },
  }),
  presentation: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        agentId: string
        presentation: Parameters<AgentHqApiClient['updateAgentPresentation']>[2]
      }>
    ) => client.updateAgentPresentation(workspaceId, input.agentId, input.presentation),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['updateAgentPresentation']>>) => {
      queryClient.setQueryData(agentQueryKeys.detail(workspaceId, result.agent.id), result)
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list(workspaceId) })
    },
  }),
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

export function useAgentListQuery(client: AgentHqApiClient, workspaceId?: string) {
  return useQuery(agentQueryOptions.list(client, workspaceId))
}
export function useAgentQuery(client: AgentHqApiClient, workspaceId?: string, agentId?: string) {
  return useQuery(agentQueryOptions.detail(client, workspaceId, agentId))
}
export function useCreateAgentMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(agentMutationOptions.create(client, useQueryClient(), workspaceId))
}
export function useArchiveAgentMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(agentMutationOptions.archive(client, useQueryClient(), workspaceId))
}
export function useAssignAgentRoomMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(agentMutationOptions.assignRoom(client, useQueryClient(), workspaceId))
}
export function useUpdateAgentPresentationMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(agentMutationOptions.presentation(client, useQueryClient(), workspaceId))
}
export function useChangeAgentProfileMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(agentMutationOptions.profile(client, useQueryClient(), workspaceId))
}

export function useTaskListQuery(client: AgentHqApiClient, workspaceId?: string) {
  return useQuery(taskQueryOptions.list(client, workspaceId))
}
export function useTaskQuery(client: AgentHqApiClient, workspaceId?: string, taskId?: string) {
  return useQuery(taskQueryOptions.detail(client, workspaceId, taskId))
}
export function useCreateTaskMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(taskMutationOptions.create(client, useQueryClient(), workspaceId))
}
export function useUpdateTaskMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(taskMutationOptions.update(client, useQueryClient(), workspaceId))
}
export function useAssignTaskMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(taskMutationOptions.assign(client, useQueryClient(), workspaceId))
}
export function useMoveTaskRoomMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(taskMutationOptions.moveRoom(client, useQueryClient(), workspaceId))
}
export function useQueueTaskMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(taskMutationOptions.queue(client, useQueryClient(), workspaceId))
}
export function useCancelTaskMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(taskMutationOptions.cancel(client, useQueryClient(), workspaceId))
}
export function useArchiveTaskMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(taskMutationOptions.archive(client, useQueryClient(), workspaceId))
}
export function useSetTaskDependenciesMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(taskMutationOptions.dependencies(client, useQueryClient(), workspaceId))
}
export function useSetTaskArtifactsMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(taskMutationOptions.artifacts(client, useQueryClient(), workspaceId))
}
export function useSetTaskConversationMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(taskMutationOptions.conversation(client, useQueryClient(), workspaceId))
}
