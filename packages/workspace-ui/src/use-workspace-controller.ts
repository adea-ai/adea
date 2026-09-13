import { createEffect, createMemo, createSignal } from 'solid-js'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import type { ChannelSummary, TaskSummary } from '@adea-ai/types'
import {
  useAgentListQuery,
  useArchiveAgentMutation,
  useArchiveChannelMutation,
  useArchiveTaskMutation,
  useArtifactListQuery,
  useAssignAgentRoomMutation,
  useAssignTaskMutation,
  useCancelTaskMutation,
  useChangeAgentProfileMutation,
  useChannelListQuery,
  useCompleteTaskMutation,
  useCreateAgentMutation,
  useCreateDirectChannelMutation,
  useCreateGroupChannelMutation,
  useCreateRoomMutation,
  useCreateTaskMutation,
  useUpdateTaskMutation,
  useMoveTaskRoomMutation,
  useMarkAllReadMutation,
  useMarkChannelReadMutation,
  useMarkThreadReadMutation,
  useQueueTaskMutation,
  useReadStateQuery,
  useReviewTaskMutation,
  useRoomListQuery,
  useSetTaskConversationMutation,
  useSetTaskDependenciesMutation,
  useStartTaskMutation,
  useTaskListQuery,
  useUpdateAgentPresentationMutation,
  useUpdateChannelMutation,
  useUpdateRoomMutation,
  useWorkspaceBootstrapQuery,
} from '@adea-ai/data'
import { useWorkspaceEventStream } from '@adea-ai/data/provider'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'

import { projectWorkspaceNavigation } from './workspace-model'
import { useWorkspacePersistence } from './use-workspace-persistence'
import { createClientRequestId } from './request-id'

function command(prefix: string, expectedVersion?: number) {
  const id = createClientRequestId()
  return {
    correlationId: `ui:${prefix}:${id}`,
    expectedVersion,
    idempotencyKey: `${prefix}:${id}`,
    requestId: id,
  }
}

export function useWorkspaceController(providedClient?: AgentHqApiClient) {
  const [defaultClient] = createSignal(createApiClient())
  const client = () => providedClient ?? defaultClient()
  const persistenceReady = useWorkspacePersistence()
  const bootstrap = useWorkspaceBootstrapQuery(client())
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  const selectedChannelId = useWorkspaceState((state) => state.selectedChannelId)
  // Solid Query backs `data` with a resource: a read while the resource is
  // unresolved suspends the consumer, and query option accessors run during
  // render. Read `data` only once the query reports success.
  const bootstrapData = () => (bootstrap.isSuccess ? bootstrap.data : undefined)
  const activeWorkspace = () =>
    bootstrapData()?.workspaces.find(({ id }) => id === selectedWorkspaceId()) ??
    bootstrapData()?.activeWorkspace
  const workspaceId = () => activeWorkspace()?.id
  useWorkspaceEventStream({
    headers: () => client().eventStreamHeaders(),
    url: () => {
      const id = workspaceId()
      return id ? client().workspaceEventStreamUrl(id) : undefined
    },
    workspaceId,
  })
  const rooms = useRoomListQuery(client(), workspaceId)
  const channels = useChannelListQuery(client(), workspaceId)
  const agents = useAgentListQuery(client(), workspaceId)
  const tasks = useTaskListQuery(client(), workspaceId)
  const artifacts = useArtifactListQuery(client(), workspaceId)
  const readState = useReadStateQuery(client(), workspaceId)
  const navigation = createMemo(() =>
    projectWorkspaceNavigation(rooms.data ?? [], channels.data ?? [])
  )
  const createRoom = useCreateRoomMutation(client(), () => workspaceId() ?? '')
  const createGroup = useCreateGroupChannelMutation(client(), () => workspaceId() ?? '')
  const createDirect = useCreateDirectChannelMutation(client(), () => workspaceId() ?? '')
  const createAgent = useCreateAgentMutation(client(), () => workspaceId() ?? '')
  const archiveAgent = useArchiveAgentMutation(client(), () => workspaceId() ?? '')
  const assignAgentRoom = useAssignAgentRoomMutation(client(), () => workspaceId() ?? '')
  const changeAgentProfile = useChangeAgentProfileMutation(client(), () => workspaceId() ?? '')
  const updateAgentPresentation = useUpdateAgentPresentationMutation(
    client(),
    () => workspaceId() ?? ''
  )
  const createTask = useCreateTaskMutation(client(), () => workspaceId() ?? '')
  const updateTask = useUpdateTaskMutation(client(), () => workspaceId() ?? '')
  const assignTask = useAssignTaskMutation(client(), () => workspaceId() ?? '')
  const moveTask = useMoveTaskRoomMutation(client(), () => workspaceId() ?? '')
  const dependencies = useSetTaskDependenciesMutation(client(), () => workspaceId() ?? '')
  const queueTask = useQueueTaskMutation(client(), () => workspaceId() ?? '')
  const startTask = useStartTaskMutation(client(), () => workspaceId() ?? '')
  const completeTask = useCompleteTaskMutation(client(), () => workspaceId() ?? '')
  const reviewTask = useReviewTaskMutation(client(), () => workspaceId() ?? '')
  const cancelTask = useCancelTaskMutation(client(), () => workspaceId() ?? '')
  const archiveTask = useArchiveTaskMutation(client(), () => workspaceId() ?? '')
  const taskConversation = useSetTaskConversationMutation(client(), () => workspaceId() ?? '')
  const markAllRead = useMarkAllReadMutation(client(), () => workspaceId() ?? '')
  const markChannelRead = useMarkChannelReadMutation(client(), () => workspaceId() ?? '')
  const markThreadRead = useMarkThreadReadMutation(client(), () => workspaceId() ?? '')
  const updateRoom = useUpdateRoomMutation(client(), () => workspaceId() ?? '')
  const updateChannel = useUpdateChannelMutation(client(), () => workspaceId() ?? '')
  const archiveChannel = useArchiveChannelMutation(client(), () => workspaceId() ?? '')

  createEffect(() => {
    if (!persistenceReady() || !bootstrap.data || activeWorkspace()) return
    workspaceStore.getState().setSelectedWorkspaceId(bootstrap.data.activeWorkspace.id)
  })

  let explicitSelection: string | null = null
  createEffect(() => {
    const channelList = channels.data
    if (!channelList?.length || channelList.some(({ id }) => id === selectedChannelId())) {
      if (explicitSelection && channelList?.some(({ id }) => id === selectedChannelId()))
        explicitSelection = null
      return
    }
    // An explicit selection (freshly created channel, sidebar click) wins over the
    // auto-default while the channel list refetch catches up. Stale persisted ids
    // never pass through selectChannel, so they still fall back below.
    if (selectedChannelId() && selectedChannelId() === explicitSelection) return
    const firstRoom = navigation().rooms.find(({ selectionChannelId }) => selectionChannelId)
    const firstChannel =
      firstRoom?.selectionChannelId ??
      navigation().directAgentChannels[0]?.id ??
      navigation().groupChannels[0]?.id
    if (firstChannel) {
      workspaceStore.getState().setSelectedRoomId(firstRoom?.room.id ?? null)
      workspaceStore.getState().setSelectedChannelId(firstChannel)
    }
  })

  const selectWorkspace = (nextWorkspaceId: string) => {
    const nextWorkspace = bootstrap.data?.workspaces.find(({ id }) => id === nextWorkspaceId)
    if (!nextWorkspace || nextWorkspace.id === activeWorkspace()?.id) return
    workspaceStore.getState().switchWorkspace(nextWorkspace.id, nextWorkspace.scene)
  }
  const selectChannel = (channelId: string, roomId?: string) => {
    explicitSelection = channelId
    workspaceStore.getState().setSelectedRoomId(roomId ?? null)
    workspaceStore.getState().setSelectedChannelId(channelId)
  }
  const taskMutation = <T>(mutation: { mutateAsync: (input: T) => Promise<unknown> }, input: T) =>
    mutation.mutateAsync(input).then(() => undefined)
  const taskInput = (task: TaskSummary, prefix: string) => command(prefix, task.version)

  return {
    get activeWorkspace() {
      return activeWorkspace()
    },
    get agents() {
      return agents.data ?? []
    },
    get artifacts() {
      return artifacts.data ?? []
    },
    agentActions: {
      archive: (agentId: string) => archiveAgent.mutateAsync(agentId).then(() => undefined),
      assignRoom: (agentId: string, roomId: string | null) =>
        assignAgentRoom.mutateAsync({ agentId, roomId }).then(() => undefined),
      profile: (
        agentId: string,
        profile: Parameters<typeof changeAgentProfile.mutateAsync>[0]['profile']
      ) => changeAgentProfile.mutateAsync({ agentId, profile }).then(() => undefined),
      presentation: (
        agentId: string,
        presentation: Parameters<typeof updateAgentPresentation.mutateAsync>[0]['presentation']
      ) => updateAgentPresentation.mutateAsync({ agentId, presentation }).then(() => undefined),
    },
    get agentBusy() {
      return [archiveAgent, assignAgentRoom, changeAgentProfile, updateAgentPresentation].some(
        ({ isPending }) => isPending
      )
    },
    bootstrap,
    get channels() {
      return channels.data ?? []
    },
    client: client(),
    createAgent: (input: Parameters<typeof createAgent.mutateAsync>[0]) =>
      createAgent.mutateAsync(input).then(() => undefined),
    get createAgentBusy() {
      return createAgent.isPending
    },
    createGroup: async (title: string) => {
      const result = await createGroup.mutateAsync({
        idempotencyKey: createClientRequestId(),
        title,
      })
      selectChannel(result.channel.id)
    },
    get createGroupBusy() {
      return createGroup.isPending
    },
    createRoom: async (input: Readonly<{ functionKey: string; name: string }>) => {
      const result = await createRoom.mutateAsync(input)
      const refreshedChannels = await channels.refetch()
      const primaryChannel = refreshedChannels.data?.find(
        (channel) =>
          channel.kind === 'room' &&
          channel.roomId === result.room.id &&
          channel.isPrimaryRoomChannel
      )
      if (primaryChannel) selectChannel(primaryChannel.id, result.room.id)
      else workspaceStore.getState().setSelectedRoomId(result.room.id)
    },
    get createRoomBusy() {
      return createRoom.isPending
    },
    roomActions: {
      update: (roomId: string, update: Readonly<{ functionKey?: string; name?: string }>) =>
        updateRoom.mutateAsync({ roomId, update }).then(() => undefined),
    },
    get roomBusy() {
      return updateRoom.isPending
    },
    channelActions: {
      archive: (channel: ChannelSummary) =>
        archiveChannel
          .mutateAsync({ channelId: channel.id, expectedVersion: channel.version })
          .then(() => undefined),
      rename: (channel: ChannelSummary, title: string) =>
        updateChannel
          .mutateAsync({
            channelId: channel.id,
            expectedVersion: channel.version,
            update: { title },
          })
          .then(() => undefined),
    },
    get channelBusy() {
      return updateChannel.isPending || archiveChannel.isPending
    },
    navigation,
    get readState() {
      return readState.data?.readState ?? []
    },
    readStateActions: {
      markAllRead: () => markAllRead.mutateAsync().then(() => undefined),
      markChannel: (input: Parameters<typeof markChannelRead.mutateAsync>[0]) =>
        markChannelRead.mutateAsync(input).then(() => undefined),
      markThread: (input: Parameters<typeof markThreadRead.mutateAsync>[0]) =>
        markThreadRead.mutateAsync(input).then(() => undefined),
    },
    openAgentConversation: async (agentId: string) => {
      const result = await createDirect.mutateAsync(agentId)
      selectChannel(result.channel.id)
    },
    get persistenceReady() {
      return persistenceReady()
    },
    get rooms() {
      return rooms.data ?? []
    },
    selectChannel,
    selectWorkspace,
    get selectedChannel() {
      return channels.data?.find(({ id }) => id === selectedChannelId())
    },
    taskActions: {
      archive: (task: TaskSummary) =>
        taskMutation(archiveTask, { command: taskInput(task, 'archive'), taskId: task.id }),
      assign: (task: TaskSummary, agentId: string | null) =>
        taskMutation(assignTask, { agentId, command: taskInput(task, 'assign'), taskId: task.id }),
      cancel: (task: TaskSummary) =>
        taskMutation(cancelTask, { command: taskInput(task, 'cancel'), taskId: task.id }),
      create: (
        task: Readonly<{
          kind?: TaskSummary['kind']
          objective: string
          priority: TaskSummary['priority']
          title: string
        }>
      ) => taskMutation(createTask, { command: command('create-task'), task }),
      update: (
        task: TaskSummary,
        update: Readonly<{
          kind?: TaskSummary['kind']
          objective?: string
          priority?: TaskSummary['priority']
          title?: string
        }>
      ) =>
        taskMutation(updateTask, {
          command: taskInput(task, 'update'),
          taskId: task.id,
          update,
        }),
      dependencies: (task: TaskSummary, dependencyIds: readonly string[]) =>
        taskMutation(dependencies, {
          command: taskInput(task, 'dependencies'),
          dependencyIds,
          taskId: task.id,
        }),
      moveRoom: (task: TaskSummary, roomId: string | null) =>
        taskMutation(moveTask, { command: taskInput(task, 'move-room'), roomId, taskId: task.id }),
      openConversation: async (task: TaskSummary) => {
        let channelId = task.conversation.channelId
        if (!channelId && task.roomId)
          channelId = navigation().rooms.find(
            ({ room }) => room.id === task.roomId
          )?.selectionChannelId
        if (!channelId) throw new Error('Task conversation unavailable')
        if (!task.conversation.channelId)
          await taskConversation.mutateAsync({
            command: taskInput(task, 'conversation'),
            conversation: { channelId },
            taskId: task.id,
          })
        selectChannel(channelId, task.roomId)
      },
      queue: (task: TaskSummary) =>
        taskMutation(queueTask, { command: taskInput(task, 'queue'), taskId: task.id }),
      review: (task: TaskSummary) =>
        taskMutation(reviewTask, { command: taskInput(task, 'review'), taskId: task.id }),
      start: (task: TaskSummary) =>
        taskMutation(startTask, { command: taskInput(task, 'start'), taskId: task.id }),
      complete: (task: TaskSummary) =>
        taskMutation(completeTask, { command: taskInput(task, 'complete'), taskId: task.id }),
    },
    get taskBusy() {
      return [
        archiveTask,
        assignTask,
        cancelTask,
        completeTask,
        createTask,
        dependencies,
        moveTask,
        queueTask,
        reviewTask,
        startTask,
        taskConversation,
        updateTask,
      ].some(({ isPending }) => isPending)
    },
    get tasks() {
      return tasks.data ?? []
    },
    get workspaceId() {
      return workspaceId()
    },
    workspaceQueries: [rooms, channels, agents, tasks, artifacts, readState],
  }
}
