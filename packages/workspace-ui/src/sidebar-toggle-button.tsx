import { PanelLeftClose, PanelLeftOpen } from 'lucide-solid'
import { Show } from 'solid-js'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

/**
 * The standalone mobile navigation opener, shared by views without the
 * workspace top bar so its position, size, theme, and icon cannot drift. The
 * main WorkspaceFrame keeps using its top-bar control — the frame hides this
 * opener at desktop widths and the sheet's focus restoration returns to the
 * top-bar control, so this button must stay outside the Sheet's trigger
 * contract on purpose.
 *
 * `expanded` reflects the shared sidebar state; the control swaps its icon
 * and label accordingly. Pressing it always asks for the open sheet.
 */
export function SidebarToggleButton(props: { expanded: boolean; onOpen: () => void }) {
  const label = () => (props.expanded ? 'Close workspace navigation' : 'Open workspace navigation')

  return (
    <ActionButton
      type="button"
      class="conventional-mobile-menu"
      touchTarget="comfortable"
      tooltip={label()}
      aria-label={label()}
      aria-expanded={props.expanded}
      onClick={() => props.onOpen()}
    >
      <Show when={props.expanded} fallback={<PanelLeftOpen aria-hidden="true" />}>
        <PanelLeftClose aria-hidden="true" />
      </Show>
    </ActionButton>
  )
}
