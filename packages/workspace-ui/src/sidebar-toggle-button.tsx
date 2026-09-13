'use client'

import { PanelLeftClose, PanelLeftOpen } from 'lucide-solid'
import { Show } from 'solid-js'

/**
 * The fixed sidebar expand/collapse control, shared by every view (chat
 * shell, virtual scene, desktop, web) so position, size, theme, and icon
 * can never drift. Styled entirely by `.conventional-mobile-menu`.
 *
 * `expanded` reflects the sidebar state; the control swaps its icon and
 * label accordingly. The workspace CSS hides it while the sidebar is open.
 */
export function SidebarToggleButton(props: {
  expanded: boolean
  onToggle: (open: boolean) => void
}) {
  return (
    <button
      type="button"
      class="conventional-mobile-menu"
      aria-label={props.expanded ? 'Close workspace navigation' : 'Open workspace navigation'}
      aria-expanded={props.expanded}
      onClick={() => props.onToggle(!props.expanded)}
    >
      <Show when={props.expanded} fallback={<PanelLeftOpen aria-hidden="true" />}>
        <PanelLeftClose aria-hidden="true" />
      </Show>
    </button>
  )
}
