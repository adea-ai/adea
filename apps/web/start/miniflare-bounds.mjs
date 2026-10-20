// Bounded, cancellation-aware waits for the Miniflare fixture harness. A stalled
// startup or dispose must fail within its bound, and an interruption must win over a
// pending wait, so cleanup always runs. Nothing here starts or stops a process itself.

export class BoundedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BoundedError'
  }
}

// Settles with the promise's outcome, or rejects when the bound passes or the signal
// aborts first. The timer and listener are always released.
export function withDeadline(promise, ms, label, signal) {
  return new Promise((ok, fail) => {
    let timer
    const finish = (settle, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle(value)
    }
    const onAbort = () => finish(fail, signal.reason ?? new BoundedError(`${label} was aborted`))
    if (signal?.aborted) return onAbort()
    timer = setTimeout(
      () => finish(fail, new BoundedError(`${label} did not finish within ${ms} ms`)),
      ms
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(ok, value),
      (error) => finish(fail, error)
    )
  })
}

// Waits for a Miniflare instance to be ready, bounded and abortable.
export function startBounded(mf, { ms, signal, label = 'Miniflare startup' }) {
  return withDeadline(mf.ready, ms, label, signal)
}

// Disposes a Miniflare instance within a bound. A dispose that never settles is
// reported, not awaited forever.
export function disposeBounded(mf, { ms = 15_000, label = 'Miniflare dispose' } = {}) {
  return withDeadline(
    Promise.resolve().then(() => mf.dispose()),
    ms,
    label
  )
}
