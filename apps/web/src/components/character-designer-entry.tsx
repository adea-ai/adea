import { VirtualUnavailable } from '@adea-ai/workspace-ui/virtual-unavailable'
import { VirtualView } from '@adea-ai/workspace-ui/virtual-view'

export function CharacterDesignerEntry(props: { initialCharacter: string }) {
  // The pack's cold character-studio surface, behind the same entitlement
  // gate as the standard virtual view. Falls back to the offline card on
  // packs without the surface or unentitled deployments.
  return (
    <VirtualView
      surface="character-designer"
      mountOptions={{
        character: props.initialCharacter,
        onClose: () => {
          const url = new URL(window.location.href)
          url.searchParams.delete('characterDesigner')
          window.location.assign(url)
        },
      }}
      fallback={<VirtualUnavailable sceneLabel="Character designer" />}
    />
  )
}
