import { getCloudflareContext } from '@opennextjs/cloudflare'

import { readDatabaseUrl, type DatabaseEnvironment } from '@adea-ai/db/config'

function isCloudflareWorkers(): boolean {
  return globalThis.navigator?.userAgent === 'Cloudflare-Workers'
}

function readHyperdriveConnectionString(): string {
  // Throws outside the Workers runtime (or when the binding is missing),
  // which drops through to DATABASE_URL below.
  // NOTE: the HYPERDRIVE member comes from the generated cloudflare-env.d.ts
  // (merged onto the adapter's built-in CloudflareEnv). The `build` script
  // runs `cf-typegen` first so the file always exists, including in CI where
  // there is no wrangler login.
  const binding = getCloudflareContext().env.HYPERDRIVE
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
  return !isCloudflareWorkers()
}
