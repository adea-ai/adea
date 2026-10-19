import { readDatabaseUrl, type DatabaseEnvironment } from '@adea-ai/db/config'

import { workerBindings } from './worker-bindings'

/** Which connection role the Worker resolved: the edge pooler or a direct URL. */
export type DatabaseConnectionSource = 'hyperdrive' | 'direct'

export interface ResolvedDatabaseConnection {
  connectionString: string
  source: DatabaseConnectionSource
}

function readHyperdriveConnectionString(): string | undefined {
  // The Worker entry captures bindings before any request is handled, so an
  // absent binding here means a non-Workers runtime (Bun tests, scripts), which
  // resolves DATABASE_URL instead. Hyperdrive terminates TLS on its own hop, so
  // the binding string is not held to the hosted `sslmode` rule that a direct
  // URL must satisfy.
  const connectionString = workerBindings()?.HYPERDRIVE?.connectionString
  if (typeof connectionString !== 'string' || connectionString.length === 0) return undefined
  return connectionString
}

export function resolveDatabaseConnection(
  environment: DatabaseEnvironment = process.env
): ResolvedDatabaseConnection {
  const hyperdrive = readHyperdriveConnectionString()
  if (hyperdrive !== undefined) return { connectionString: hyperdrive, source: 'hyperdrive' }
  return { connectionString: readDatabaseUrl(environment), source: 'direct' }
}

export function resolveDatabaseConnectionString(
  environment: DatabaseEnvironment = process.env
): string {
  return resolveDatabaseConnection(environment).connectionString
}

export function shouldRegisterDatabaseShutdownHooks(): boolean {
  // Workers isolates never receive SIGINT/SIGTERM; skip process hooks there.
  return globalThis.navigator?.userAgent !== 'Cloudflare-Workers'
}
