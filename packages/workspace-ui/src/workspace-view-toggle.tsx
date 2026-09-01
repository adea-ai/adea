'use client'

import { MessageSquareText, PanelsTopLeft } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@agent-hq/ui/components/ui/toggle-group'

export type WorkspaceView = 'chat' | 'virtual'

export function WorkspaceViewToggle({
  onChange,
  value,
}: Readonly<{
  onChange: (view: WorkspaceView) => void
  value: WorkspaceView
}>) {
  return (
    <ToggleGroup
      aria-label="Workspace view"
      spacing={0}
      size="sm"
      variant="outline"
      value={[value]}
      onValueChange={(nextValue) => {
        const nextView = nextValue[0] as WorkspaceView | undefined
        if (nextView) onChange(nextView)
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
    </ToggleGroup>
  )
}
