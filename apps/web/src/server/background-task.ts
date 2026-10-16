/**
 * Work that must finish after the response without holding it up.
 *
 * The Worker entry captures the runtime's `waitUntil` (from
 * `cloudflare:workers`), so the isolate stays alive until the task settles.
 * Outside the Worker (Bun tests, scripts) nothing is captured and the task
 * simply runs detached. A task never rejects into the caller: failures are
 * the task's own to log.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly,
 * and the compiled client-boundary guard keeps `src/server` out of browsers.
 */
type WaitUntil = (promise: Promise<unknown>) => void

let captured: WaitUntil | undefined

export function captureWaitUntil(waitUntil: WaitUntil | undefined): void {
  captured = waitUntil
}

export function runAfterResponse(task: () => Promise<unknown>): void {
  const settled = Promise.resolve()
    .then(task)
    .then(
      () => undefined,
      () => undefined
    )
  try {
    captured?.(settled)
  } catch {
    // Outside a request context `waitUntil` throws; the task still runs.
  }
}

/**
 * Keeps the isolate alive until `work` settles, for teardown that outlives the
 * response (a stream's database client closing after the client went away).
 * `work` must not reject; outside the Worker nothing is captured and this is a
 * no-op.
 */
export function keepAliveUntil(work: Promise<unknown>): void {
  try {
    captured?.(
      work.then(
        () => undefined,
        () => undefined
      )
    )
  } catch {
    // Outside a request context `waitUntil` throws; the work still runs.
  }
}
