'use client'

import { useEffect, useMemo, useState } from 'react'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import { useChannelListQuery, useRoomListQuery, useWorkspaceBootstrapQuery } from '@adea-ai/data'
import { useWorkspaceStore } from '@adea-ai/state'

import { useWorkspacePersistence } from './use-workspace-persistence'
import { SidebarToggleButton } from './sidebar-toggle-button'
import { projectWorkspaceNavigation } from './workspace-model'

export function VirtualRoomControls({
  client: providedClient,
  openChat,
}: Readonly<{
  client?: AgentHqApiClient
  openChat: () => void
}>) {
  const [defaultClient] = useState(() => createApiClient())
  const client = providedClient ?? defaultClient
  const persistenceReady = useWorkspacePersistence()
  const bootstrap = useWorkspaceBootstrapQuery(client)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId)
  const selectedRoomId = useWorkspaceStore((state) => state.selectedRoomId)
  const selectedChannelId = useWorkspaceStore((state) => state.selectedChannelId)
  const setSelectedWorkspaceId = useWorkspaceStore((state) => state.setSelectedWorkspaceId)
  const setSelectedRoomId = useWorkspaceStore((state) => state.setSelectedRoomId)
  const setSelectedChannelId = useWorkspaceStore((state) => state.setSelectedChannelId)
  const activeWorkspace =
    bootstrap.data?.workspaces.find(({ id }) => id === selectedWorkspaceId) ??
    bootstrap.data?.activeWorkspace
  const rooms = useRoomListQuery(client, activeWorkspace?.id)
  const channels = useChannelListQuery(client, activeWorkspace?.id)
  const navigation = useMemo(
    () => projectWorkspaceNavigation(rooms.data ?? [], channels.data ?? []),
    [channels.data, rooms.data]
  )

  useEffect(() => {
    if (!persistenceReady || !bootstrap.data || selectedWorkspaceId) return
    setSelectedWorkspaceId(bootstrap.data.activeWorkspace.id)
  }, [bootstrap.data, persistenceReady, selectedWorkspaceId, setSelectedWorkspaceId])

  useEffect(() => {
    if (!navigation.rooms.length) return
    const selectedChannel = channels.data?.find(({ id }) => id === selectedChannelId)
    const selectedRoom = navigation.rooms.find(({ room }) => room.id === selectedRoomId)
    if (selectedRoom && selectedChannel?.roomId === selectedRoom.room.id) return
    const firstRoom = selectedRoom ?? navigation.rooms[0]!
    setSelectedRoomId(firstRoom.room.id)
    setSelectedChannelId(firstRoom.selectionChannelId ?? null)
  }, [
    channels.data,
    navigation.rooms,
    selectedChannelId,
    selectedRoomId,
    setSelectedChannelId,
    setSelectedRoomId,
  ])

  return <SidebarToggleButton expanded={false} onToggle={() => openChat()} />
}
