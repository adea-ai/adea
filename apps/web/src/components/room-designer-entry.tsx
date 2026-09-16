import { VirtualUnavailable } from '@adea-ai/workspace-ui/virtual-unavailable'

export function RoomDesignerEntry(props: {
  initialCharacter: string
  initialScene: 'home' | 'work'
  onClose: () => void
}) {
  return (
    <VirtualUnavailable
      sceneLabel={props.initialScene === 'work' ? 'Work room designer' : 'Home room designer'}
      onOpenChat={props.onClose}
    />
  )
}
