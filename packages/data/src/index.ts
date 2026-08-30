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

export const artifactQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'artifacts'] as const,
  detail: (workspaceId: string, artifactId: string) =>
    ['workspaces', workspaceId, 'artifacts', 'detail', artifactId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'artifacts', 'list'] as const,
}

export const artifactQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, artifactId?: string) => ({
    queryKey: artifactQueryKeys.detail(workspaceId ?? '', artifactId ?? ''),
    queryFn: () => client.getArtifact(workspaceId!, artifactId!),
    enabled: Boolean(workspaceId && artifactId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: artifactQueryKeys.list(workspaceId ?? ''),
    queryFn: () => client.listArtifacts(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
}

function artifactMutationSuccess(queryClient: QueryClient, workspaceId: string) {
  return async (result: Awaited<ReturnType<AgentHqApiClient['getArtifact']>>) => {
    queryClient.setQueryData(artifactQueryKeys.detail(workspaceId, result.artifact.id), result)
    await queryClient.invalidateQueries({ queryKey: artifactQueryKeys.list(workspaceId) })
  }
}

export const artifactMutationOptions = {
  availability: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        artifactId: string
        availability: Parameters<AgentHqApiClient['setArtifactAvailability']>[2]
        expectedVersion: number
      }>
    ) =>
      client.setArtifactAvailability(
        workspaceId,
        input.artifactId,
        input.availability,
        input.expectedVersion
      ),
    onSuccess: artifactMutationSuccess(queryClient, workspaceId),
  }),
  create: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createArtifact']>[1]) =>
      client.createArtifact(workspaceId, input),
    onSuccess: artifactMutationSuccess(queryClient, workspaceId),
  }),
  delete: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Readonly<{ artifactId: string; expectedVersion: number }>) =>
      client.deleteArtifact(workspaceId, input.artifactId, input.expectedVersion),
    onSuccess: artifactMutationSuccess(queryClient, workspaceId),
  }),
}

export const channelQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'channels'] as const,
  detail: (workspaceId: string, channelId: string) =>
    ['workspaces', workspaceId, 'channels', 'detail', channelId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'channels', 'list'] as const,
}
export const messageQueryKeys = {
  all: (workspaceId: string, channelId: string) =>
    ['workspaces', workspaceId, 'channels', channelId, 'messages'] as const,
  detail: (workspaceId: string, messageId: string) =>
    ['workspaces', workspaceId, 'messages', 'detail', messageId] as const,
  list: (workspaceId: string, channelId: string) =>
    ['workspaces', workspaceId, 'channels', channelId, 'messages', 'list'] as const,
}
export const channelQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, channelId?: string) => ({
    queryKey: channelQueryKeys.detail(workspaceId ?? '', channelId ?? ''),
    queryFn: () => client.getChannel(workspaceId!, channelId!),
    enabled: Boolean(workspaceId && channelId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: channelQueryKeys.list(workspaceId ?? ''),
    queryFn: () => client.listChannels(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
}
export const messageQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, messageId?: string) => ({
    queryKey: messageQueryKeys.detail(workspaceId ?? '', messageId ?? ''),
    queryFn: () => client.getMessage(workspaceId!, messageId!),
    enabled: Boolean(workspaceId && messageId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string, channelId?: string) => ({
    queryKey: messageQueryKeys.list(workspaceId ?? '', channelId ?? ''),
    queryFn: () => client.listMessages(workspaceId!, channelId!),
    enabled: Boolean(workspaceId && channelId),
  }),
}

function channelMutationSuccess(queryClient: QueryClient, workspaceId: string) {
  return async (result: Awaited<ReturnType<AgentHqApiClient['getChannel']>>) => {
    queryClient.setQueryData(channelQueryKeys.detail(workspaceId, result.channel.id), result)
    await queryClient.invalidateQueries({ queryKey: channelQueryKeys.list(workspaceId) })
  }
}
export const channelMutationOptions = {
  archive: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Readonly<{ channelId: string; expectedVersion: number }>) =>
      client.archiveChannel(workspaceId, input.channelId, input.expectedVersion),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  direct: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (agentId: string) => client.createDirectAgentChannel(workspaceId, agentId),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  group: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createGroupChannel']>[1]) =>
      client.createGroupChannel(workspaceId, input),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  participants: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        channelId: string
        expectedVersion: number
        participants: Parameters<AgentHqApiClient['setChannelParticipants']>[2]
      }>
    ) =>
      client.setChannelParticipants(
        workspaceId,
        input.channelId,
        input.participants,
        input.expectedVersion
      ),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  room: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createRoomChannel']>[1]) =>
      client.createRoomChannel(workspaceId, input),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  update: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        channelId: string
        expectedVersion: number
        update: Parameters<AgentHqApiClient['updateChannel']>[2]
      }>
    ) => client.updateChannel(workspaceId, input.channelId, input.update, input.expectedVersion),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
}

function messageMutationSuccess(queryClient: QueryClient, workspaceId: string, channelId?: string) {
  return async (result: Awaited<ReturnType<AgentHqApiClient['getMessage']>>) => {
    queryClient.setQueryData(messageQueryKeys.detail(workspaceId, result.message.id), result)
    const targetChannelId = channelId ?? result.message.channelId
    await queryClient.invalidateQueries({
      queryKey: messageQueryKeys.all(workspaceId, targetChannelId),
    })
  }
}
export const messageMutationOptions = {
  create: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string,
    channelId: string
  ) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createMessage']>[2]) =>
      client.createMessage(workspaceId, channelId, input),
    onSuccess: messageMutationSuccess(queryClient, workspaceId, channelId),
  }),
  delete: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Readonly<{ expectedVersion: number; messageId: string }>) =>
      client.deleteMessage(workspaceId, input.messageId, input.expectedVersion),
    onSuccess: messageMutationSuccess(queryClient, workspaceId),
  }),
  edit: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        edit: Parameters<AgentHqApiClient['editMessage']>[2]
        expectedVersion: number
        messageId: string
      }>
    ) => client.editMessage(workspaceId, input.messageId, input.edit, input.expectedVersion),
    onSuccess: messageMutationSuccess(queryClient, workspaceId),
  }),
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

export function useArtifactListQuery(client: AgentHqApiClient, workspaceId?: string) {
  return useQuery(artifactQueryOptions.list(client, workspaceId))
}
export function useArtifactQuery(
  client: AgentHqApiClient,
  workspaceId?: string,
  artifactId?: string
) {
  return useQuery(artifactQueryOptions.detail(client, workspaceId, artifactId))
}
export function useCreateArtifactMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(artifactMutationOptions.create(client, useQueryClient(), workspaceId))
}
export function useSetArtifactAvailabilityMutation(
  client: AgentHqApiClient,
  workspaceId: string
) {
  return useMutation(artifactMutationOptions.availability(client, useQueryClient(), workspaceId))
}
export function useDeleteArtifactMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(artifactMutationOptions.delete(client, useQueryClient(), workspaceId))
}

export function useChannelListQuery(client: AgentHqApiClient, workspaceId?: string) {
  return useQuery(channelQueryOptions.list(client, workspaceId))
}
export function useChannelQuery(
  client: AgentHqApiClient,
  workspaceId?: string,
  channelId?: string
) {
  return useQuery(channelQueryOptions.detail(client, workspaceId, channelId))
}
export function useCreateRoomChannelMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(channelMutationOptions.room(client, useQueryClient(), workspaceId))
}
export function useCreateDirectChannelMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(channelMutationOptions.direct(client, useQueryClient(), workspaceId))
}
export function useCreateGroupChannelMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(channelMutationOptions.group(client, useQueryClient(), workspaceId))
}
export function useUpdateChannelMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(channelMutationOptions.update(client, useQueryClient(), workspaceId))
}
export function useArchiveChannelMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(channelMutationOptions.archive(client, useQueryClient(), workspaceId))
}
export function useSetChannelParticipantsMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(channelMutationOptions.participants(client, useQueryClient(), workspaceId))
}
export function useMessageListQuery(
  client: AgentHqApiClient,
  workspaceId?: string,
  channelId?: string
) {
  return useQuery(messageQueryOptions.list(client, workspaceId, channelId))
}
export function useMessageQuery(
  client: AgentHqApiClient,
  workspaceId?: string,
  messageId?: string
) {
  return useQuery(messageQueryOptions.detail(client, workspaceId, messageId))
}
export function useCreateMessageMutation(
  client: AgentHqApiClient,
  workspaceId: string,
  channelId: string
) {
  return useMutation(
    messageMutationOptions.create(client, useQueryClient(), workspaceId, channelId)
  )
}
export function useEditMessageMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(messageMutationOptions.edit(client, useQueryClient(), workspaceId))
}
export function useDeleteMessageMutation(client: AgentHqApiClient, workspaceId: string) {
  return useMutation(messageMutationOptions.delete(client, useQueryClient(), workspaceId))
}
