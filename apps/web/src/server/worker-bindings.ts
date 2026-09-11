/**
 * Cloudflare bindings captured by the Worker entry before any request is
 * handled, replacing the OpenNext `getCloudflareContext()` integration. The
 * capture is synchronous so database-connection resolution keeps its existing
 * synchronous contract; outside the Worker (Bun tests, scripts) nothing is
 * captured and resolution falls back to process environment variables.
 *
 * No `server-only` marker here (or in request-scope): both are imported by
 * Bun-run unit tests, where that package's default entry throws. The compiled
 * client-boundary guard keeps these modules out of browser bundles instead.
 */
export interface WorkerBindings {
  HYPERDRIVE?: { connectionString?: string | undefined }
}

let bindings: WorkerBindings | undefined

export function captureWorkerBindings(env: unknown): void {
  bindings = env as WorkerBindings
}

export function workerBindings(): WorkerBindings | undefined {
  return bindings
}
