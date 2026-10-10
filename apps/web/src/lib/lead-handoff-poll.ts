import { createEffect, onCleanup } from 'solid-js'

/** Lead-turn status re-reads run this often while an unsettled turn is
 *  observed and the window is visible — the same 30s cadence family as the
 *  workspace run counts and navigation refreshes. */
export const LEAD_STATUS_POLL_MS = 30_000

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false

/**
 * Re-reads lead-turn status while `shouldPoll` holds: every 30s while the
 * document is visible and the browser reports a connection, once more on
 * every visible/online transition, and never while hidden or offline. A
 * failed read keeps the last observed supply rather than clearing it, so
 * an idle or failing poll notifies nothing downstream; overlapping reads
 * stay safe because supply application is epoch-guarded at the call site.
 */
export function createLeadStatusPoll(
  read: () => void,
  shouldPoll: () => boolean,
  options: Readonly<{ intervalMs?: number }> = {}
): void {
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const refresh = () => {
    if (disposed || !shouldPoll() || !visible() || !online()) return
    try {
      read()
    } catch {
      // A failed poll keeps last state; the manual check stays available.
    }
  }
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const start = () => {
    stop()
    if (!shouldPoll() || !visible() || !online()) return
    timer = setInterval(refresh, options.intervalMs ?? LEAD_STATUS_POLL_MS)
  }
  const onVisibility = () => {
    if (visible()) {
      refresh()
      start()
    } else stop()
  }
  const onOnline = () => {
    refresh()
    start()
  }

  createEffect(() => {
    if (shouldPoll()) {
      refresh()
      start()
    } else stop()
  })
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline)
  onCleanup(() => {
    disposed = true
    stop()
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisibility)
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
  })
}
