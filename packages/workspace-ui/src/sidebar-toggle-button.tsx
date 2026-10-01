import { PanelLeftClose, PanelLeftOpen } from 'lucide-solid'
import { Show } from 'solid-js'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { SheetTrigger } from '@adea-ai/ui/components/ui/sheet'

/**
 * The standalone mobile Sheet trigger, shared by views without the workspace
 * top bar so its position, size, theme, and icon cannot drift. The main
 * WorkspaceFrame uses its top-bar control to open the same controlled Sheet.
 *
 * `expanded` reflects the shared sidebar state; the control swaps its icon
 * and label accordingly. The Sheet root owns the open/close and focus behavior.
 */
export function SidebarToggleButton(props: { expanded: boolean }) {
  const label = () => (props.expanded ? 'Close workspace navigation' : 'Open workspace navigation')

  return (
    <SheetTrigger
      as={ActionButton}
      type="button"
      class="conventional-mobile-menu"
      touchTarget="comfortable"
      tooltip={label()}
      aria-label={label()}
      aria-expanded={props.expanded}
    >
      <Show when={props.expanded} fallback={<PanelLeftOpen aria-hidden="true" />}>
        <PanelLeftClose aria-hidden="true" />
      </Show>
    </SheetTrigger>
  )
}
