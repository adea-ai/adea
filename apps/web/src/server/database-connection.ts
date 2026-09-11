import { readDatabaseUrl, type DatabaseEnvironment } from '@adea-ai/db/config'

import { workerBindings } from './worker-bindings'

function readHyperdriveConnectionString(): string {
  // The Worker entry captures bindings before any request is handled, so this
  // throws only outside the Workers runtime (Bun tests, scripts), which drops
  // through to DATABASE_URL below.
  const binding = workerBindings()?.HYPERDRIVE
  const connectionString = binding?.connectionString
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new Error('HYPERDRIVE binding is unavailable')
  }
  return connectionString
}

export function resolveDatabaseConnectionString(
  environment: DatabaseEnvironment = process.env
): string {
  try {
    return readHyperdriveConnectionString()
  } catch {
    return readDatabaseUrl(environment)
  }
}

export function shouldRegisterDatabaseShutdownHooks(): boolean {
  // Workers isolates never receive SIGINT/SIGTERM; skip process hooks there.
  return globalThis.navigator?.userAgent !== 'Cloudflare-Workers'
}
