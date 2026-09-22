// Key routing for the terminal surface (issue #396): full-screen TUIs get
// every key unchanged, and the pane intercepts only its own explicit
// shortcuts.
//
// The pinned regression this fixes: an earlier pane intercepted plain
// Ctrl+F/Cmd+F on the surface, which corrupts readline and TUI programs
// (Ctrl+F is forward-char). The search shortcut now requires the Shift
// modifier on Ctrl (the platform convention) or the meta key on macOS, and
// copy mirrors it, so unmodified control keys always reach the PTY byte for
// byte. IME composition keydowns (isComposing / keyCode 229) are never
// intercepted, so composition confirm/cancel keys are untouched.
import type { EditorMode } from './editor'

/** The minimal key facts the routing decision needs (DOM-event shaped). */
export type PaneKeyEvent = Readonly<{
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing?: boolean
  /** Legacy composition marker (Safari/Chrome fire keyCode 229). */
  keyCode?: number
}>

export type PaneKeyAction = 'search' | 'copy-selection' | 'none'

/** True while an IME composition owns the keyboard. */
export function isImeComposing(event: PaneKeyEvent): boolean {
  return event.isComposing === true || event.keyCode === 229
}

/** Search: Cmd/Cmd+F on macOS, Ctrl+Shift+F elsewhere. Never plain Ctrl+F. */
function isSearchShortcut(event: PaneKeyEvent): boolean {
  const key = event.key.toLowerCase()
  if (key !== 'f') return false
  if (event.metaKey && !event.ctrlKey) return true
  return event.ctrlKey && event.shiftKey && !event.altKey
}

/** Copy selection: Cmd+C on macOS, Ctrl+Shift+C elsewhere. */
function isCopyShortcut(event: PaneKeyEvent): boolean {
  const key = event.key.toLowerCase()
  if (key !== 'c') return false
  if (event.metaKey && !event.ctrlKey && !event.altKey) return true
  return event.ctrlKey && event.shiftKey && !event.altKey
}

/**
 * Routes one surface keydown. `'none'` hands the key to the terminal
 * untouched; the two pane actions execute in the pane and must never reach
 * the PTY. Both modes route identically — raw mode is pass-through by
 * construction, and the editor (compose mode) is a separate element that
 * rarely sees surface keys at all.
 */
export function routePaneKey(event: PaneKeyEvent, _mode: EditorMode): PaneKeyAction {
  if (isImeComposing(event)) return 'none'
  if (isSearchShortcut(event)) return 'search'
  if (isCopyShortcut(event)) return 'copy-selection'
  return 'none'
}
