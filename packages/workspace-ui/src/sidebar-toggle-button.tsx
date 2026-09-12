'use client'

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'

/**
 * The fixed sidebar expand/collapse control, shared by every view (chat
 * shell, virtual scene, desktop, web) so position, size, theme, and icon
 * can never drift. Styled entirely by `.conventional-mobile-menu`.
 *
 * `expanded` reflects the sidebar state; the control swaps its icon and
 * label accordingly. The workspace CSS hides it while the sidebar is open.
 */
export function SidebarToggleButton({
  expanded,
  onToggle,
}: Readonly<{
  expanded: boolean
  onToggle: (open: boolean) => void
}>) {
  return (
    <button
      type="button"
      className="conventional-mobile-menu"
      aria-label={expanded ? 'Close workspace navigation' : 'Open workspace navigation'}
      aria-expanded={expanded}
      onClick={() => onToggle(!expanded)}
    >
      {expanded ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
    </button>
  )
}
