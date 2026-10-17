import { HostedSimEntry } from './hosted-sim-entry'
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
        <HostedSimEntry
          client={props.client}
          surface="room-designer"
          scene={props.initialScene}
          character={props.initialCharacter}
          onClose={props.onClose}
        />
      </div>
    </main>
  )
}
