/**
 * A dynamic import that deduplicates concurrent callers and remembers the
 * module once loaded, so a surface that remounts renders without a pending
 * state. A failed import is not remembered: the next call retries it.
 */
export function createLazyModule<T>(load: () => Promise<T>) {
  let loaded: T | undefined
  let pending: Promise<T> | undefined
  return {
    /** The module when an earlier call has finished loading it. */
    current: () => loaded,
    load: () =>
      (pending ??= load().then(
        (module) => {
          loaded = module
          return module
        },
        (error: unknown) => {
          pending = undefined
          throw error
        }
      )),
  }
}
