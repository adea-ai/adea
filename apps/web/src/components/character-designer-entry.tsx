import { VirtualUnavailable } from '@adea-ai/workspace-ui/virtual-unavailable'
import { VirtualView } from '@adea-ai/workspace-ui/virtual-view'

export function CharacterDesignerEntry(props: { initialCharacter: string; onClose: () => void }) {
  // The pack's cold character-studio surface, behind the same entitlement
  // gate as the standard virtual view. Falls back to the offline card on
  // packs without the surface or unentitled deployments.
  return (
    <main class="workspace-shell workspace-shell--contextual">
      <div class="workspace-scene-viewport">
        <VirtualView
          surface="character-designer"
          mountOptions={{
            character: props.initialCharacter,
            onClose: props.onClose,
          }}
          fallback={
            <VirtualUnavailable
              contained
              sceneLabel="Character designer"
              onOpenChat={props.onClose}
            />
          }
        />
      </div>
    </main>
  )
}
