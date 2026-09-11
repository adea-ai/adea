import { AsyncLocalStorage } from 'node:async_hooks'

type Closer = () => Promise<void> | void

const scope = new AsyncLocalStorage<Set<Closer>>()

/**
 * Runs one API request inside a scope that collects per-request cleanup
 * callbacks (short-lived database connections) and runs them once the
 * response has been produced — the replacement for Next's request `after()`.
 */
export async function withRequestScope<T>(work: () => Promise<T> | T): Promise<T> {
  const closers = new Set<Closer>()
  try {
    return await scope.run(closers, work)
  } finally {
    const pending = [...closers]
    closers.clear()
    await Promise.allSettled(pending.map((close) => close()))
  }
}

export function registerRequestCleanup(closer: Closer): void {
  scope.getStore()?.add(closer)
}
