import type { AgentHqApiClient } from '@adea-ai/api-client'
import { HostedSimEntry } from './hosted-sim-entry'

export function CharacterDesignerEntry(props: {
  initialCharacter: string
  onClose: () => void
  client: AgentHqApiClient
}) {
  return (
    <main class="workspace-shell workspace-shell--contextual">
      <div class="workspace-scene-viewport">
        <HostedSimEntry
          client={props.client}
          surface="character-designer"
          character={props.initialCharacter}
          onClose={props.onClose}
        />
      </div>
    </main>
  )
}
