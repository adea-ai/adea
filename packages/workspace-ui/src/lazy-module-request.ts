import { createEffect, onCleanup } from 'solid-js'

/** Bind a shared import's callbacks to one request in the current owner. */
export function createLazyModuleRequest<T>(
  options: Readonly<{
    request: () => string | undefined
    current: () => T | undefined
    load: () => Promise<T>
    onLoad: (module: T) => void
    onError: () => void
  }>
) {
  createEffect(() => {
    const request = options.request()
    if (request === undefined || options.current() !== undefined) return
    let active = true
    onCleanup(() => {
      active = false
    })
    // Cleanup fences disposal and A -> B -> A changes. The identity check also
    // fences a changed request before its effect has rerun (for example in a batch).
    const isCurrent = () => active && options.request() === request
    options.load().then(
      (module) => {
        if (isCurrent()) options.onLoad(module)
      },
      () => {
        if (isCurrent()) options.onError()
      }
    )
  })
}
