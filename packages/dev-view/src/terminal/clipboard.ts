// Permissioned clipboard model for the terminal pane (issue #396).
//
// Copy always goes through the host's permissioned clipboard seam (#471
// substrate). Denial is a typed outcome that degrades the affordance in
// place — honest label, a repair hint, selection itself never breaks — and
// is never a thrown error or a silent no-op.
export type ClipboardOutcome = 'granted' | 'denied' | 'unavailable'

export type ClipboardState = Readonly<{
  /** Result of the most recent copy attempt, when one was made. */
  last?: ClipboardOutcome
  attempts: number
}>

export function createClipboardState(): ClipboardState {
  return { attempts: 0 }
}

export function applyCopyOutcome(state: ClipboardState, outcome: ClipboardOutcome): ClipboardState {
  return { last: outcome, attempts: state.attempts + 1 }
}

export type ClipboardPresentation = Readonly<{
  /** Button label reflecting the honest current state. */
  label: string
  /** Repair hint; empty when nothing needs saying. */
  hint: string
  /** Screen-reader announcement after an attempt; undefined when quiet. */
  announcement?: string
  /** Whether the copy affordance is degraded (denied or unavailable). */
  degraded: boolean
}>

export function clipboardPresentation(state: ClipboardState): ClipboardPresentation {
  if (state.last === 'denied') {
    return {
      label: 'Copy blocked',
      hint: 'Clipboard access was denied. Select the text and use your system copy shortcut.',
      announcement: 'Copy blocked: clipboard access was denied',
      degraded: true,
    }
  }
  if (state.last === 'unavailable') {
    return {
      label: 'Copy unavailable',
      hint: 'No clipboard access in this context. Select the text to copy it manually.',
      announcement: 'Copy unavailable in this context',
      degraded: true,
    }
  }
  if (state.last === 'granted') {
    return { label: 'Copied', hint: '', degraded: false }
  }
  return { label: 'Copy', hint: '', degraded: false }
}

/**
 * Classifies a failed permissioned copy into the typed outcome. A missing
 * clipboard API and unexpected failures are `unavailable` (nothing promised
 * was refused); an explicit permission refusal is `denied`.
 */
export function classifyClipboardFailure(error?: unknown): ClipboardOutcome {
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  ) {
    return 'denied'
  }
  return 'unavailable'
}
