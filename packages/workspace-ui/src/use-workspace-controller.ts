import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createApiClient, type AgentHqApiClient } from '@agent-hq/api-client'
import type { ChannelSummary, TaskSummary } from '@agent-hq/types'
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
} from '@agent-hq/data'
import { useWorkspaceStore } from '@agent-hq/state'

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
  const [defaultClient] = useState(() => createApiClient())
  const client = providedClient ?? defaultClient
  const persistenceReady = useWorkspacePersistence()
  const bootstrap = useWorkspaceBootstrapQuery(client)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId)
  const selectedChannelId = useWorkspaceStore((state) => state.selectedChannelId)
  const setSelectedWorkspaceId = useWorkspaceStore((state) => state.setSelectedWorkspaceId)
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace)
  const setSelectedRoomId = useWorkspaceStore((state) => state.setSelectedRoomId)
  const setSelectedChannelId = useWorkspaceStore((state) => state.setSelectedChannelId)
  const activeWorkspace =
    bootstrap.data?.workspaces.find(({ id }) => id === selectedWorkspaceId) ??
    bootstrap.data?.activeWorkspace
  const workspaceId = activeWorkspace?.id
  const rooms = useRoomListQuery(client, workspaceId)
  const channels = useChannelListQuery(client, workspaceId)
  const agents = useAgentListQuery(client, workspaceId)
  const tasks = useTaskListQuery(client, workspaceId)
  const artifacts = useArtifactListQuery(client, workspaceId)
  const readState = useReadStateQuery(client, workspaceId)
  const navigation = useMemo(
    () => projectWorkspaceNavigation(rooms.data ?? [], channels.data ?? []),
    [channels.data, rooms.data]
  )
  const createRoom = useCreateRoomMutation(client, workspaceId ?? '')
  const createGroup = useCreateGroupChannelMutation(client, workspaceId ?? '')
  const createDirect = useCreateDirectChannelMutation(client, workspaceId ?? '')
  const createAgent = useCreateAgentMutation(client, workspaceId ?? '')
  const archiveAgent = useArchiveAgentMutation(client, workspaceId ?? '')
  const assignAgentRoom = useAssignAgentRoomMutation(client, workspaceId ?? '')
  const changeAgentProfile = useChangeAgentProfileMutation(client, workspaceId ?? '')
  const updateAgentPresentation = useUpdateAgentPresentationMutation(client, workspaceId ?? '')
  const createTask = useCreateTaskMutation(client, workspaceId ?? '')
  const updateTask = useUpdateTaskMutation(client, workspaceId ?? '')
  const assignTask = useAssignTaskMutation(client, workspaceId ?? '')
  const moveTask = useMoveTaskRoomMutation(client, workspaceId ?? '')
  const dependencies = useSetTaskDependenciesMutation(client, workspaceId ?? '')
  const queueTask = useQueueTaskMutation(client, workspaceId ?? '')
  const startTask = useStartTaskMutation(client, workspaceId ?? '')
  const completeTask = useCompleteTaskMutation(client, workspaceId ?? '')
  const reviewTask = useReviewTaskMutation(client, workspaceId ?? '')
  const cancelTask = useCancelTaskMutation(client, workspaceId ?? '')
  const archiveTask = useArchiveTaskMutation(client, workspaceId ?? '')
  const taskConversation = useSetTaskConversationMutation(client, workspaceId ?? '')
  const markAllRead = useMarkAllReadMutation(client, workspaceId ?? '')
  const markChannelRead = useMarkChannelReadMutation(client, workspaceId ?? '')
  const markThreadRead = useMarkThreadReadMutation(client, workspaceId ?? '')
  const updateRoom = useUpdateRoomMutation(client, workspaceId ?? '')
  const updateChannel = useUpdateChannelMutation(client, workspaceId ?? '')
  const archiveChannel = useArchiveChannelMutation(client, workspaceId ?? '')

  useEffect(() => {
    if (!persistenceReady || !bootstrap.data || activeWorkspace) return
    setSelectedWorkspaceId(bootstrap.data.activeWorkspace.id)
  }, [activeWorkspace, bootstrap.data, persistenceReady, setSelectedWorkspaceId])

  const explicitSelectionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!channels.data?.length || channels.data.some(({ id }) => id === selectedChannelId)) {
      if (explicitSelectionRef.current && channels.data?.some(({ id }) => id === selectedChannelId))
        explicitSelectionRef.current = null
      return
    }
    // An explicit selection (freshly created channel, sidebar click) wins over the
    // auto-default while the channel list refetch catches up. Stale persisted ids
    // never pass through selectChannel, so they still fall back below.
    if (selectedChannelId && selectedChannelId === explicitSelectionRef.current) return
    const firstRoom = navigation.rooms.find(({ selectionChannelId }) => selectionChannelId)
    const firstChannel =
      firstRoom?.selectionChannelId ??
      navigation.directAgentChannels[0]?.id ??
      navigation.groupChannels[0]?.id
    if (firstChannel) {
      setSelectedRoomId(firstRoom?.room.id ?? null)
      setSelectedChannelId(firstChannel)
    }
  }, [channels.data, navigation, selectedChannelId, setSelectedChannelId, setSelectedRoomId])

  const selectWorkspace = useCallback(
    (nextWorkspaceId: string) => {
      const nextWorkspace = bootstrap.data?.workspaces.find(({ id }) => id === nextWorkspaceId)
      if (!nextWorkspace || nextWorkspace.id === activeWorkspace?.id) return
      switchWorkspace(nextWorkspace.id, nextWorkspace.scene)
    },
    [activeWorkspace?.id, bootstrap.data?.workspaces, switchWorkspace]
  )
  const selectChannel = useCallback(
    (channelId: string, roomId?: string) => {
      explicitSelectionRef.current = channelId
      setSelectedRoomId(roomId ?? null)
      setSelectedChannelId(channelId)
    },
    [setSelectedChannelId, setSelectedRoomId]
  )
  const taskMutation = <T>(mutation: { mutateAsync: (input: T) => Promise<unknown> }, input: T) =>
    mutation.mutateAsync(input).then(() => undefined)
  const taskInput = (task: TaskSummary, prefix: string) => command(prefix, task.version)

  return {
    activeWorkspace,
    agents: agents.data ?? [],
    artifacts: artifacts.data ?? [],
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
    agentBusy: [archiveAgent, assignAgentRoom, changeAgentProfile, updateAgentPresentation].some(
      ({ isPending }) => isPending
    ),
    bootstrap,
    channels: channels.data ?? [],
    client,
    createAgent: (input: Parameters<typeof createAgent.mutateAsync>[0]) =>
      createAgent.mutateAsync(input).then(() => undefined),
    createAgentBusy: createAgent.isPending,
    createGroup: async (title: string) => {
      const result = await createGroup.mutateAsync({
        idempotencyKey: createClientRequestId(),
        title,
      })
      selectChannel(result.channel.id)
    },
    createGroupBusy: createGroup.isPending,
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
      else setSelectedRoomId(result.room.id)
    },
    createRoomBusy: createRoom.isPending,
    roomActions: {
      update: (roomId: string, update: Readonly<{ functionKey?: string; name?: string }>) =>
        updateRoom.mutateAsync({ roomId, update }).then(() => undefined),
    },
    roomBusy: updateRoom.isPending,
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
    channelBusy: updateChannel.isPending || archiveChannel.isPending,
    navigation,
    readState: readState.data?.readState ?? [],
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
    persistenceReady,
    rooms: rooms.data ?? [],
    selectChannel,
    selectWorkspace,
    selectedChannel: channels.data?.find(({ id }) => id === selectedChannelId),
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
          channelId = navigation.rooms.find(
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
    taskBusy: [
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
    ].some(({ isPending }) => isPending),
    tasks: tasks.data ?? [],
    workspaceId,
    workspaceQueries: [rooms, channels, agents, tasks, artifacts, readState],
  }
}
