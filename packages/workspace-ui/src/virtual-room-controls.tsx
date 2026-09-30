import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import {
  settledData,
  useChannelListQuery,
  useRoomListQuery,
  useWorkspaceBootstrapQuery,
} from '@adea-ai/data'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'

import { useWorkspacePersistence } from './use-workspace-persistence'
import { Button } from '@adea-ai/ui/components/ui/button'
import { projectWorkspaceNavigation } from './workspace-model'

export function VirtualRoomControls(props: { client?: AgentHqApiClient; openChat: () => void }) {
  const [defaultClient] = createSignal(createApiClient())
  const client = () => props.client ?? defaultClient()
  const persistenceReady = useWorkspacePersistence()
  const bootstrap = useWorkspaceBootstrapQuery(client())
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  const sidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
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

  // Follow the same rule as `use-workspace-controller`: a selection that is
  // already valid is left alone, and only a missing or stale one is defaulted.
  //
  // This used to require the selected ROOM and the selected channel to agree,
  // which a direct-Agent conversation never satisfies — it has no room, so
  // `selectedRoomId()` is null, the guard failed, and mounting the Virtual view
  // forced room[0] and its channel into the store. Returning to Chat then
  // showed a different conversation, and `setSelectedChannelId` nulls
  // `threadRootMessageId`, so the open thread was closed too.
  createEffect(() => {
    if (!navigation().rooms.length) return
    const currentChannelId = selectedChannelId()
    if (currentChannelId && settledData(channels)?.some(({ id }) => id === currentChannelId)) return
    const firstRoom = navigation().rooms.find(({ selectionChannelId }) => selectionChannelId)
    if (!firstRoom) return
    workspaceStore.getState().setSelectedRoomId(firstRoom.room.id)
    workspaceStore.getState().setSelectedChannelId(firstRoom.selectionChannelId ?? null)
  })

  return (
    <aside class="virtual-context-sidebar" aria-label="Virtual navigation" hidden={!sidebarOpen()}>
      <h1>{activeWorkspace()?.name ?? 'Virtual'}</h1>
      <h2>Rooms</h2>
      <Show
        when={!rooms.isError}
        fallback={
          <p role="alert">
            Rooms could not be loaded.{' '}
            <Button type="button" onClick={() => void rooms.refetch()}>
              Retry
            </Button>
          </p>
        }
      >
        <Show
          when={navigation().rooms.length > 0}
          fallback={<p>{rooms.isPending ? 'Loading rooms…' : 'No rooms yet.'}</p>}
        >
          <For each={navigation().rooms}>
            {(item) => (
              <Button
                variant="ghost"
                class="virtual-context-sidebar__room"
                disabled={!item.selectionChannelId}
                onClick={() => {
                  workspaceStore.getState().setSelectedRoomId(item.room.id)
                  workspaceStore.getState().setSelectedChannelId(item.selectionChannelId ?? null)
                  workspaceStore.getState().setActiveSurface('conversation')
                  props.openChat()
                }}
              >
                {item.room.name}
              </Button>
            )}
          </For>
        </Show>
      </Show>
      <h2>Workspace</h2>
      <Button
        variant="ghost"
        class="virtual-context-sidebar__room"
        onClick={() => props.openChat()}
      >
        Open conversations
      </Button>
    </aside>
  )
}
