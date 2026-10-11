import type { ChannelSummary } from '@adea-ai/types'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import {
  settledData,
  useAgentListQuery,
  useArchiveChannelMutation,
  useChannelListQuery,
  useCreateGroupChannelMutation,
  useCreateRoomMutation,
  useMarkAllReadMutation,
  usePrefetchChannelMessages,
  useReadStateQuery,
  useRoomListQuery,
  useUpdateChannelMutation,
  useUpdateRoomMutation,
  useWorkspaceBootstrapQuery,
} from '@adea-ai/data'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { createEffect, createMemo, createSignal, lazy, Show, Suspense, type JSX } from 'solid-js'

import { createClientRequestId } from './request-id'
import { useWorkspacePersistence } from './use-workspace-persistence'
import { projectWorkspaceNavigation, reconcileWorkspaceChannelSelection } from './workspace-model'
import { WorkspaceSidebar } from './workspace-sidebar'

const CreateGroupDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({ default: module.CreateGroupDialog }))
)
const CreateRoomDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({ default: module.CreateRoomDialog }))
)

type SidebarDialog = 'create-group' | 'create-room' | null

export function VirtualRoomControls(props: {
  archiveAction?: JSX.Element
  client?: AgentHqApiClient
  openChat: () => void
  restoreFocusRef?: () => HTMLElement | undefined
}) {
  const [defaultClient] = createSignal(createApiClient())
  const client = () => props.client ?? defaultClient()
  const persistenceReady = useWorkspacePersistence()
  const bootstrap = useWorkspaceBootstrapQuery(client())
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  const sidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
  const collapsedRoomIds = useWorkspaceState((state) => state.collapsedRoomIds)
  const selectedChannelId = useWorkspaceState((state) => state.selectedChannelId)
  const bootstrapData = () => settledData(bootstrap)
  const activeWorkspace = () =>
    bootstrapData()?.workspaces.find(({ id }) => id === selectedWorkspaceId()) ??
    bootstrapData()?.activeWorkspace
  const workspaceId = () => activeWorkspace()?.id
  const rooms = useRoomListQuery(client(), workspaceId)
  const channels = useChannelListQuery(client(), workspaceId)
  const agents = useAgentListQuery(client(), workspaceId)
  const readState = useReadStateQuery(client(), workspaceId)
  const createRoomMutation = useCreateRoomMutation(client(), () => workspaceId() ?? '')
  const createGroupMutation = useCreateGroupChannelMutation(client(), () => workspaceId() ?? '')
  const updateRoomMutation = useUpdateRoomMutation(client(), () => workspaceId() ?? '')
  const updateChannelMutation = useUpdateChannelMutation(client(), () => workspaceId() ?? '')
  const archiveChannelMutation = useArchiveChannelMutation(client(), () => workspaceId() ?? '')
  const markAllReadMutation = useMarkAllReadMutation(client(), () => workspaceId() ?? '')
  const prefetchChannelMessages = usePrefetchChannelMessages(client(), workspaceId)
  const [dialog, setDialog] = createSignal<SidebarDialog>(null)
  const navigation = createMemo(() =>
    projectWorkspaceNavigation(settledData(rooms) ?? [], settledData(channels) ?? [])
  )

  createEffect(() => {
    const data = bootstrapData()
    if (!persistenceReady() || !data || selectedWorkspaceId()) return
    workspaceStore.getState().setSelectedWorkspaceId(data.activeWorkspace.id)
  })

  // Leave every valid room, direct-agent, or group selection untouched. The
  // store's channel setter closes an open thread, so only stale selections may
  // be replaced while Virtual is mounted.
  let explicitSelection: string | null = null
  createEffect(() => {
    const decision = reconcileWorkspaceChannelSelection({
      channels: settledData(channels),
      explicitSelection,
      navigation: navigation(),
      selectedChannelId: selectedChannelId(),
    })
    if (decision.action === 'preserve') {
      if (decision.clearExplicitSelection) explicitSelection = null
      return
    }
    if (decision.action !== 'select') return
    workspaceStore.getState().setSelectedRoomId(decision.roomId)
    workspaceStore.getState().setSelectedChannelId(decision.channelId)
  })

  const routeToChat = (surface: 'agents' | 'conversation') => {
    workspaceStore.getState().setActiveSurface(surface)
    if (window.matchMedia('(max-width: 48rem)').matches) {
      const sheetWasOpen = sidebarOpen()
      workspaceStore.getState().setMobileSidebarOpen(false)
      // Switching to Chat disposes the sheet before its close-time focus
      // restoration can run, and the swapped-in view rebuilds the chrome, so
      // re-hand focus to the stored opener until it sticks (bounded to two
      // seconds so it never fights a later, intentional focus move).
      if (sheetWasOpen) {
        const restoreOpener = window.setInterval(() => {
          const opener = props.restoreFocusRef?.()
          if (opener && document.activeElement === opener) {
            window.clearInterval(restoreOpener)
            return
          }
          if (opener?.isConnected) opener.focus({ preventScroll: true })
        }, 50)
        window.setTimeout(() => window.clearInterval(restoreOpener), 2000)
      }
    }
    props.openChat()
  }
  const selectChannel = (channelId: string, roomId?: string) => {
    explicitSelection = channelId
    workspaceStore.getState().setSelectedRoomId(roomId ?? null)
    workspaceStore.getState().setSelectedChannelId(channelId)
    routeToChat('conversation')
  }
  const createRoom = async (input: Readonly<{ functionKey: string; name: string }>) => {
    const result = await createRoomMutation.mutateAsync(input)
    const refreshedChannels = await channels.refetch()
    const primaryChannel = settledData(refreshedChannels)?.find(
      (channel) =>
        channel.kind === 'room' && channel.roomId === result.room.id && channel.isPrimaryRoomChannel
    )
    if (primaryChannel) selectChannel(primaryChannel.id, result.room.id)
    else {
      workspaceStore.getState().setSelectedRoomId(result.room.id)
      routeToChat('conversation')
    }
  }
  const createGroup = async (title: string) => {
    const result = await createGroupMutation.mutateAsync({
      idempotencyKey: createClientRequestId(),
      title,
    })
    selectChannel(result.channel.id)
  }
  const archiveChannel = (channel: ChannelSummary) =>
    archiveChannelMutation
      .mutateAsync({ channelId: channel.id, expectedVersion: channel.version })
      .then(() => undefined)
  const renameChannel = (channel: ChannelSummary, title: string) =>
    updateChannelMutation
      .mutateAsync({
        channelId: channel.id,
        expectedVersion: channel.version,
        update: { title },
      })
      .then(() => undefined)
  const updateRoom = (roomId: string, update: Readonly<{ functionKey?: string; name?: string }>) =>
    updateRoomMutation.mutateAsync({ roomId, update }).then(() => undefined)
  const queryIssue = () => {
    if (bootstrap.isError)
      return { message: 'Workspace could not be loaded.', retry: () => void bootstrap.refetch() }
    if (rooms.isError)
      return { message: 'Rooms could not be loaded.', retry: () => void rooms.refetch() }
    if (channels.isError)
      return {
        message: 'Conversations could not be loaded.',
        retry: () => void channels.refetch(),
      }
    if (agents.isError)
      return { message: 'Agents could not be loaded.', retry: () => void agents.refetch() }
    if (readState.isError)
      return { message: 'Unread state could not be loaded.', retry: () => void readState.refetch() }
    return null
  }
  const sidebarStatus = () => {
    const issue = queryIssue()
    if (issue) {
      return (
        <Alert variant="destructive" class="conventional-sidebar-error">
          <AlertDescription>
            {issue.message}{' '}
            <ActionButton
              type="button"
              tooltip="Retry loading workspace data"
              onClick={() => issue.retry()}
            >
              Retry
            </ActionButton>
          </AlertDescription>
        </Alert>
      )
    }
    if (bootstrap.isPending)
      return (
        <EmptyDescription role="status" class="conventional-sidebar-empty">
          Loading workspace…
        </EmptyDescription>
      )
    if (rooms.isPending && !settledData(rooms))
      return (
        <EmptyDescription role="status" class="conventional-sidebar-empty">
          Loading rooms…
        </EmptyDescription>
      )
    return undefined
  }

  return (
    <>
      <WorkspaceSidebar
        archiveAction={props.archiveAction}
        agents={settledData(agents) ?? []}
        channelBusy={updateChannelMutation.isPending || archiveChannelMutation.isPending}
        collapsedRoomIds={collapsedRoomIds()}
        mobileOpen={sidebarOpen()}
        navigation={navigation()}
        onArchiveChannel={archiveChannel}
        onChannelIntent={prefetchChannelMessages}
        onCreateGroup={() => setDialog('create-group')}
        onCreateRoom={() => setDialog('create-room')}
        onMarkAllRead={() => markAllReadMutation.mutateAsync().then(() => undefined)}
        onOpenAgents={() => routeToChat('agents')}
        onRenameChannel={renameChannel}
        onSelectChannel={selectChannel}
        onToggleMobile={(open) => workspaceStore.getState().setMobileSidebarOpen(open)}
        onToggleRoom={(roomId) => workspaceStore.getState().toggleRoomCollapsed(roomId)}
        onUpdateRoom={updateRoom}
        roomBusy={updateRoomMutation.isPending}
        selectedChannelId={selectedChannelId()}
        readState={settledData(readState)?.readState ?? []}
        restoreFocusRef={props.restoreFocusRef}
        status={sidebarStatus()}
        workspaceReady={Boolean(activeWorkspace())}
        workspaceName={activeWorkspace()?.name ?? 'Virtual'}
      />
      <Suspense fallback={null}>
        <Show when={dialog() === 'create-room' && activeWorkspace()}>
          {(workspace) => (
            <CreateRoomDialog
              busy={createRoomMutation.isPending}
              onClose={() => setDialog(null)}
              onCreate={createRoom}
              open
              template={workspace().scene}
            />
          )}
        </Show>
        <Show when={dialog() === 'create-group'}>
          <CreateGroupDialog
            busy={createGroupMutation.isPending}
            onClose={() => setDialog(null)}
            onCreate={createGroup}
            open
          />
        </Show>
      </Suspense>
    </>
  )
}
