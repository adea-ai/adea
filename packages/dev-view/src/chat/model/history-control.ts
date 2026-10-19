// What the chat knows about loading earlier turns, kept apart from the view so the
// rules can be held by tests. The transcript stream owns the history itself
// (`loadOlder` publishes the older events before it resolves, `hasOlder` reads the
// accumulator); this only fences one attachment from the next and turns a failure into
// a state the reader can retry from.
//
// - A source that offers no `loadOlder` has no earlier turns to offer: `hasOlder` is
//   false and nothing is invented.
// - A load belongs to the attachment that started it. If the reader switches
//   conversation or the stream reattaches meanwhile, its result, failure and
//   completion are dropped, so one session's history never lands in another's state.
// - A cancelled load is not a failure. Any other failure leaves the control in place
//   (`hasOlder` stays true) with `failed` set, and the next load clears it.
// - Only one load runs at a time; asking again while one runs joins it.

/** The slice of a transcript stream this reads. */
export type HistorySource = Readonly<{
  loadOlder?: (options?: { signal?: AbortSignal }) => Promise<void>
  hasOlder?: () => boolean
}>

export type HistoryControlState = Readonly<{
  hasOlder: boolean
  loading: boolean
  failed: boolean
}>

export type HistoryControl = Readonly<{
  /** Start reading a new stream; forgets any load still running for the old one. */
  attach: (source: HistorySource | undefined) => void
  detach: () => void
  /** Re-read `hasOlder` after the transcript changed (an event arrived, a page landed). */
  refresh: () => void
  load: () => Promise<void>
}>

const IDLE: HistoryControlState = { hasOlder: false, loading: false, failed: false }

export function createHistoryControl(
  publish: (state: HistoryControlState) => void
): HistoryControl {
  let source: HistorySource | undefined
  let attachment = 0
  let running: Promise<void> | undefined
  let state = IDLE
  const set = (next: Partial<HistoryControlState>) => {
    const merged = { ...state, ...next }
    if (
      merged.hasOlder === state.hasOlder &&
      merged.loading === state.loading &&
      merged.failed === state.failed
    )
      return
    state = merged
    publish(state)
  }
  const readHasOlder = () => {
    try {
      return source?.hasOlder?.() === true && source.loadOlder !== undefined
    } catch {
      return false
    }
  }
  const attach = (next: HistorySource | undefined) => {
    attachment += 1
    source = next
    running = undefined
    set({ hasOlder: readHasOlder(), loading: false, failed: false })
  }
  const load = () => {
    if (running) return running
    const current = source
    if (!current?.loadOlder || !readHasOlder()) return Promise.resolve()
    const mine = attachment
    set({ loading: true, failed: false })
    const task = (async () => {
      try {
        await current.loadOlder?.()
        if (mine === attachment) set({ failed: false })
      } catch (error) {
        if (mine !== attachment) return
        const cancelled = error instanceof DOMException && error.name === 'AbortError'
        if (!cancelled) set({ failed: true })
      } finally {
        if (mine === attachment) {
          running = undefined
          set({ loading: false, hasOlder: readHasOlder() })
        }
      }
    })()
    running = task
    return task
  }
  return {
    attach,
    detach: () => attach(undefined),
    refresh: () => set({ hasOlder: readHasOlder() }),
    load,
  }
}
