import { workerBindings, type WorkerBindings } from './worker-bindings'

/** Workers delegate private-CA verification to the auth-only Hyperdrive origin. */
export function authDatabaseConnectionForRequest(
  bindings: WorkerBindings | undefined = workerBindings(),
  environment: Record<string, string | undefined> = process.env
): string | undefined {
  const connectionString = bindings?.AUTH_HYPERDRIVE?.connectionString
  if (typeof connectionString === 'string' && connectionString.length > 0) return connectionString
  if (!bindings || !environment.AUTH_DATABASE_URL) return undefined
  try {
    const host = new URL(environment.AUTH_DATABASE_URL).hostname
    // Disposable local Worker qualification uses its loopback PostgreSQL fixture.
    if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return undefined
  } catch {
    // Never include connection strings or parse errors in responses/logs.
  }
  throw new Error('Hosted Worker auth requires its dedicated Hyperdrive binding')
}
