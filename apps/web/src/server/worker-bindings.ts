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

type SecretsStoreBinding = { get(): Promise<string> }

/**
 * Secrets Store bindings surface on `env` as lazy clients with `get()`, not
 * as strings, so `process.env` never sees their values on its own. Every
 * hosted secret is declared as a Secrets Store binding (see
 * cloudflare.config.ts), so the Worker entry hydrates them once per request
 * entry before any handler reads `process.env`; text vars and worker secrets
 * are already strings and are left untouched.
 */
function isSecretsStoreBinding(value: unknown): value is SecretsStoreBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function'
  )
}

export async function hydrateSecretStoreBindings(env: unknown): Promise<void> {
  if (typeof env !== 'object' || env === null) return
  await Promise.all(
    Object.entries(env as Record<string, unknown>).map(async ([name, value]) => {
      if (!isSecretsStoreBinding(value)) return
      try {
        process.env[name] = await value.get()
      } catch {
        // Leave the variable absent: the consuming guard fails closed with
        // its own "not configured" response instead of a leaked store error.
      }
    })
  )
}
