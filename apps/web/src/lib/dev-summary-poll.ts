import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import type { Scope, WorkspaceRunSummaryItem } from '@adea-ai/types/dev-runtime'
import { createSignal, onCleanup, type Accessor } from 'solid-js'

import { workspaceSummaries } from './desktop-dev-runtime'

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

/** The cross-workspace run counts refresh this often while the window is visible. */
export const DEV_SUMMARY_POLL_MS = 30_000

/**
 * Polls the counts-only desktop run summary (`dev.summary.workspaces`, ADR
 * 0011) for the sidebar's collapsed workspace chips and "Needs you" strip:
 * once the runtime is ready, every 30s while the document is visible, and
 * again whenever it becomes visible. Hidden windows issue no reads. A failed
 * read keeps the last observed counts rather than guessing zeros.
 */
export function createDevSummaryPoll(
  runtime: Pick<DevRuntimeService, 'execute' | 'preferenceScope' | 'ready' | 'state'>,
  options: Readonly<{ intervalMs?: number; read?: typeof workspaceSummaries }> = {}
): Accessor<readonly WorkspaceRunSummaryItem[] | undefined> {
  const [items, setItems] = createSignal<readonly WorkspaceRunSummaryItem[]>()
  const read = options.read ?? workspaceSummaries
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  let generation = 0

  const refresh = async () => {
    if (disposed || !visible() || runtime.state().status !== 'ready') return
    const scope: Scope | undefined = runtime.preferenceScope?.()
    if (!scope) return
    const current = ++generation
    const summary = await read(runtime, scope)
    if (disposed || current !== generation || !summary) return
    setItems(summary.items)
  }

  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const start = () => {
    stop()
    if (!visible()) return
    timer = setInterval(() => void refresh(), options.intervalMs ?? DEV_SUMMARY_POLL_MS)
  }
  const onVisibility = () => {
    if (visible()) {
      void refresh()
      start()
    } else stop()
  }

  void Promise.resolve(runtime.ready)
    .catch(() => undefined)
    .then(() => {
      void refresh()
      start()
    })
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  onCleanup(() => {
    disposed = true
    stop()
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisibility)
  })
  return items
}
