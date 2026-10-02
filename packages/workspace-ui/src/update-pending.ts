import { createSignal } from 'solid-js'

/**
 * The one "an update is pending" signal for the workspace chrome. The rail's
 * account trigger and the account menu's Updates item both read it to draw
 * their accent dot; the desktop host feeds it from the SAME updater the
 * version dialog drives (every adapter answer is mirrored through
 * `noteUpdatePhase`), so there is exactly one update-checker and one state.
 */

/** Updater phases in which an update occupies the app: something is offered,
 * in flight, or waiting for the restart that finishes it. */
export const UPDATE_PENDING_PHASES = [
  'available',
  'downloading',
  'installing',
  'installed',
] as const

const [pendingSignal, setPendingSignal] = createSignal(false)

/** Mirror one updater snapshot phase into the shared pending state. */
export function noteUpdatePhase(phase: string | null | undefined): void {
  setPendingSignal(
    phase !== null &&
      phase !== undefined &&
      (UPDATE_PENDING_PHASES as readonly string[]).includes(phase)
  )
}

/** True while an update is offered, downloading, installing, or awaiting restart. */
export function updatePending(): boolean {
  return pendingSignal()
}
