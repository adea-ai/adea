import { Code2, MessageSquareText, PanelsTopLeft } from 'lucide-solid'
import { ToggleGroup, ToggleGroupItem } from '@adea-ai/ui/components/ui/toggle-group'

export type WorkspaceView = 'chat' | 'dev' | 'virtual'

export function WorkspaceViewToggle(props: {
  onChange: (view: WorkspaceView) => void
  value: WorkspaceView
}) {
  return (
    <ToggleGroup
      aria-label="Workspace view"
      spacing={0}
      size="sm"
      variant="outline"
      value={[props.value]}
      onChange={(nextValue) => {
        const nextView = nextValue[0] as WorkspaceView | undefined
        if (nextView) props.onChange(nextView)
      }}
    >
      <ToggleGroupItem aria-label="Chat view" value="chat">
        <MessageSquareText data-icon="inline-start" aria-hidden="true" />
        Chat
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Virtual view" value="virtual">
        <PanelsTopLeft data-icon="inline-start" aria-hidden="true" />
        Virtual
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Dev view" value="dev">
        <Code2 data-icon="inline-start" aria-hidden="true" />
        Dev
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
