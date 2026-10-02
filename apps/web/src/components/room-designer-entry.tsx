import { VirtualUnavailable } from '@adea-ai/workspace-ui/virtual-unavailable'
import { VirtualRoomControls } from '@adea-ai/workspace-ui/virtual-room-controls'
import { VirtualView } from '@adea-ai/workspace-ui/virtual-view'
import type { AgentHqApiClient } from '@adea-ai/api-client'

export function RoomDesignerEntry(props: {
  initialCharacter: string
  initialScene: 'home' | 'work'
  restoreFocusRef?: () => HTMLElement | undefined
  onClose: () => void
  client: AgentHqApiClient
  onOpenChat: () => void
}) {
  return (
    <main class="workspace-shell workspace-shell--contextual">
      <VirtualRoomControls
        client={props.client}
        openChat={props.onOpenChat}
        restoreFocusRef={props.restoreFocusRef}
      />
      <div class="workspace-scene-viewport">
        {/* The pack's cold room-designer surface, behind the same entitlement
            gate as the standard virtual view. Falls back to the offline card
            on packs without the surface or unentitled deployments. */}
        <VirtualView
          surface="room-designer"
          fallback={
            <VirtualUnavailable
              contained
              sceneLabel={
                props.initialScene === 'work' ? 'Work room designer' : 'Home room designer'
              }
              onOpenChat={props.onClose}
            />
          }
        />
      </div>
    </main>
  )
}
