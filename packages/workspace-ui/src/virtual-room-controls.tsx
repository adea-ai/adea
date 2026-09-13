'use client'

import { createEffect, createMemo, createSignal } from 'solid-js'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import { useChannelListQuery, useRoomListQuery, useWorkspaceBootstrapQuery } from '@adea-ai/data'
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
  // Solid Query backs `data` with a resource: a read while the resource is
  // unresolved suspends the consumer, and query option accessors run during
  // render. Read `data` only once the query reports success.
  const bootstrapData = () => (bootstrap.isSuccess ? bootstrap.data : undefined)
  const activeWorkspace = () =>
    bootstrapData()?.workspaces.find(({ id }) => id === selectedWorkspaceId()) ??
    bootstrapData()?.activeWorkspace
  const rooms = useRoomListQuery(client(), () => activeWorkspace()?.id)
  const channels = useChannelListQuery(client(), () => activeWorkspace()?.id)
  const navigation = createMemo(() =>
    projectWorkspaceNavigation(rooms.data ?? [], channels.data ?? [])
  )

  createEffect(() => {
    if (!persistenceReady() || !bootstrap.data || selectedWorkspaceId()) return
    workspaceStore.getState().setSelectedWorkspaceId(bootstrap.data.activeWorkspace.id)
  })

  createEffect(() => {
    if (!navigation().rooms.length) return
    const selectedChannel = channels.data?.find(({ id }) => id === selectedChannelId())
    const selectedRoom = navigation().rooms.find(({ room }) => room.id === selectedRoomId())
    if (selectedRoom && selectedChannel?.roomId === selectedRoom.room.id) return
    const firstRoom = selectedRoom ?? navigation().rooms[0]!
    workspaceStore.getState().setSelectedRoomId(firstRoom.room.id)
    workspaceStore.getState().setSelectedChannelId(firstRoom.selectionChannelId ?? null)
  })

  return <SidebarToggleButton expanded={false} onToggle={() => props.openChat()} />
}
