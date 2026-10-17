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
 * cloudflare.config.ts), so the Worker entry hydrates them before any handler
 * reads `process.env`; text vars and worker secrets
 * are already strings and are left untouched.
 */
function isSecretsStoreBinding(value: unknown): value is SecretsStoreBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function'
  )
}

/** Bound secret rotation staleness while avoiding a store read on every request. */
export const SECRET_BINDING_CACHE_MS = 30_000

export function createSecretBindingHydrator(now: () => number = Date.now) {
  // Only resolved configuration strings are shared. Request-owned I/O promises
  // must not be retained across Worker invocations. A new binding object gets a
  // new entry, and a rejected/expired read never falls back to a cached value.
  const cache = new WeakMap<SecretsStoreBinding, { value: string; expiresAt: number }>()
  const latestRead = new WeakMap<SecretsStoreBinding, number>()
  const latestHydration = new Map<string, number>()
  let generation = 0
  // Latest-started read wins each binding's cache; latest-started hydration
  // wins each environment name, even if its binding object was replaced.
  // Only counters and resolved strings survive an invocation, never promises.
  return async (env: unknown): Promise<void> => {
    if (typeof env !== 'object' || env === null) return
    await Promise.all(
      Object.entries(env as Record<string, unknown>).map(async ([name, binding]) => {
        if (!isSecretsStoreBinding(binding)) return
        const current = ++generation
        latestHydration.set(name, current)
        try {
          const cached = cache.get(binding)
          if (cached && cached.expiresAt > now()) {
            process.env[name] = cached.value
            return
          }
          latestRead.set(binding, current)
          const value = await binding.get()
          if (typeof value !== 'string') throw new TypeError('Invalid secret binding result')
          if (latestRead.get(binding) === current)
            cache.set(binding, { value, expiresAt: now() + SECRET_BINDING_CACHE_MS })
          if (latestHydration.get(name) === current) process.env[name] = value
        } catch {
          if (latestRead.get(binding) === current) cache.delete(binding)
          if (latestHydration.get(name) === current) delete process.env[name]
          // The consuming guard returns its existing "not configured" response;
          // no store error or secret value enters a log or response.
        }
      })
    )
  }
}

export const hydrateSecretStoreBindings = createSecretBindingHydrator()
