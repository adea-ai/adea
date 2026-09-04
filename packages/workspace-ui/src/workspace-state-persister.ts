import type { WorkspaceState } from '@agent-hq/state'

export type WorkspaceStatePersister = {
  /** Coalesces bursts of store changes into one trailing write. */
  save: (state: WorkspaceState) => void
  /** Writes any pending state immediately (tab hide, page hide, unmount). */
  flush: () => void
}

/**
 * Trailing-edge debounced writer for persisted workspace state. Store changes
 * arrive per keystroke while drafting; writing synchronously on every change
 * puts a JSON serialization plus a synchronous storage write on the main
 * thread each time. The persister keeps only the latest state and writes it
 * once the burst settles, and `flush` covers the moments the process may go
 * away before the timer fires (tab hidden, page hidden, unmount).
 */
export function createWorkspaceStatePersister(
  write: (state: WorkspaceState) => void,
  delayMs = 300,
): WorkspaceStatePersister {
  let pendingState: WorkspaceState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pendingState === null) return
    const state = pendingState
    pendingState = null
    write(state)
  }

  return {
    save: (state) => {
      pendingState = state
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, delayMs)
    },
    flush,
  }
}
