import { createEffect, createMemo, createSignal } from 'solid-js'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import {
  settledData,
  useChannelListQuery,
  useRoomListQuery,
  useWorkspaceBootstrapQuery,
} from '@adea-ai/data'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'

import { useWorkspacePersistence } from './use-workspace-persistence'
import { SidebarToggleButton } from './sidebar-toggle-button'
import { projectWorkspaceNavigation } from './workspace-model'

export function VirtualRoomControls(props: { client?: AgentHqApiClient; openChat: () => void }) {
  const [defaultClient] = createSignal(createApiClient())
  const client = () => props.client ?? defaultClient()
  const persistenceReady = useWorkspacePersistence()
  const bootstrap = useWorkspaceBootstrapQuery(client())
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  const selectedRoomId = useWorkspaceState((state) => state.selectedRoomId)
  const selectedChannelId = useWorkspaceState((state) => state.selectedChannelId)
  const bootstrapData = () => settledData(bootstrap)
  const activeWorkspace = () =>
    bootstrapData()?.workspaces.find(({ id }) => id === selectedWorkspaceId()) ??
    bootstrapData()?.activeWorkspace
  const rooms = useRoomListQuery(client(), () => activeWorkspace()?.id)
  const channels = useChannelListQuery(client(), () => activeWorkspace()?.id)
  const navigation = createMemo(() =>
    projectWorkspaceNavigation(settledData(rooms) ?? [], settledData(channels) ?? [])
  )

  createEffect(() => {
    const data = bootstrapData()
    if (!persistenceReady() || !data || selectedWorkspaceId()) return
    workspaceStore.getState().setSelectedWorkspaceId(data.activeWorkspace.id)
  })

  createEffect(() => {
    if (!navigation().rooms.length) return
    const selectedChannel = settledData(channels)?.find(({ id }) => id === selectedChannelId())
    const selectedRoom = navigation().rooms.find(({ room }) => room.id === selectedRoomId())
    if (selectedRoom && selectedChannel?.roomId === selectedRoom.room.id) return
    const firstRoom = selectedRoom ?? navigation().rooms[0]!
    workspaceStore.getState().setSelectedRoomId(firstRoom.room.id)
    workspaceStore.getState().setSelectedChannelId(firstRoom.selectionChannelId ?? null)
  })

  return <SidebarToggleButton expanded={false} onToggle={() => props.openChat()} />
}
