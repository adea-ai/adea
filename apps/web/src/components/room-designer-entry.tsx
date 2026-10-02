import { VirtualUnavailable } from '@adea-ai/workspace-ui/virtual-unavailable'
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
      {/* The designer fills the viewport: no rooms sidebar in edit mode — the
          designer's own close affordance and the top bar are the way back. */}
      <div class="workspace-scene-viewport">
        <VirtualView
          surface="room-designer"
          mountOptions={{ onClose: props.onClose }}
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
