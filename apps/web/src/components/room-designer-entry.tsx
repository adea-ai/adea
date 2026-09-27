import { VirtualUnavailable } from '@adea-ai/workspace-ui/virtual-unavailable'
import { VirtualRoomControls } from '@adea-ai/workspace-ui/virtual-room-controls'
import type { AgentHqApiClient } from '@adea-ai/api-client'

export function RoomDesignerEntry(props: {
  initialCharacter: string
  initialScene: 'home' | 'work'
  onClose: () => void
  client: AgentHqApiClient
  onOpenChat: () => void
}) {
  return (
    <main class="workspace-shell workspace-shell--contextual">
      <VirtualRoomControls client={props.client} openChat={props.onOpenChat} />
      <div class="workspace-scene-viewport">
        <VirtualUnavailable
          sceneLabel={props.initialScene === 'work' ? 'Work room designer' : 'Home room designer'}
          onOpenChat={props.onClose}
        />
      </div>
    </main>
  )
}
