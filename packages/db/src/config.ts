const CLIENT_DATABASE_KEYS = [
  'ADEA_PUBLIC_DATABASE_URL',
  'ADEA_PUBLIC_DATABASE_URL_UNPOOLED',
  'ADEA_PUBLIC_DATABASE_MIGRATION_URL',
  'NEXT_PUBLIC_DATABASE_URL',
  'NEXT_PUBLIC_DATABASE_URL_UNPOOLED',
  'NEXT_PUBLIC_DATABASE_MIGRATION_URL',
  'VITE_DATABASE_URL',
  'VITE_DATABASE_URL_UNPOOLED',
  'VITE_DATABASE_MIGRATION_URL',
] as const

export type DatabaseEnvironment = Record<string, string | undefined>

// Hosted PostgreSQL must refuse plaintext transport. Loopback is the only host
// allowed to skip TLS: local development and the disposable CI provisioners
// (`scripts/database-config.mjs` enforces the same rule for the health probe).
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
const TLS_REQUIRED_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full'])

// Neon's pooled endpoint runs PgBouncer in transaction mode (`<endpoint>-pooler`
// host). Transaction pooling multiplexes many client sessions onto shared server
// backends, so the conservative `prepare: false` stays for that endpoint only.
// Cloudflare Hyperdrive and a direct Railway PostgreSQL connection are not this
// shape: Hyperdrive supports the named prepared statements Postgres.js uses and
// documents that `prepare: false` makes the driver probe parameter types before
// every query, which transaction pooling does not reliably support.
const NEON_POOLED_HOST_MARKER = '-pooler.'
const NEON_HOST_SUFFIX = '.neon.tech'

export function isLoopbackDatabaseHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  return LOOPBACK_HOSTNAMES.has(host) || host.endsWith('.localhost')
}

export function isTransactionPooledHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  return host.includes(NEON_POOLED_HOST_MARKER) && host.endsWith(NEON_HOST_SUFFIX)
}

/**
 * The connection role a database URL names, and what it means for Postgres.js
 * prepared statements. `pooled` is true only for a host that multiplexes client
 * transactions onto shared backends (Neon's `-pooler` endpoint); a Hyperdrive or
 * direct connection keeps prepared statements.
 */
export interface DatabaseConnectionTarget {
  readonly url: string
  readonly hostname: string
  readonly hosted: boolean
  readonly pooled: boolean
  readonly preparedStatements: boolean
}

/**
 * Parses and strictly validates one server-side PostgreSQL URL. Hosted hosts
 * must carry an explicit TLS mode of `require`, `verify-ca` or `verify-full`;
 * loopback hosts may use `sslmode=disable` for local/throwaway databases.
 */
export function readDatabaseTarget(value: string, key = 'DATABASE_URL'): DatabaseConnectionTarget {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${key} must be a valid PostgreSQL URL`)
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${key} must use the PostgreSQL protocol`)
  }
  if (!url.username || !url.password || !url.hostname || url.pathname === '/') {
    throw new Error(`${key} must include role, password, host, and database`)
  }

  const hostname = url.hostname
  const hosted = !isLoopbackDatabaseHost(hostname)
  if (hosted) {
    const sslmode = url.searchParams.get('sslmode')
    if (!TLS_REQUIRED_SSL_MODES.has(sslmode ?? '')) {
      throw new Error(`Hosted ${key} must require TLS`)
    }
  }

  const pooled = isTransactionPooledHost(hostname)
  return { url: value, hostname, hosted, pooled, preparedStatements: !pooled }
}

/**
 * The prepared-statement behaviour a URL names, without the hosted-TLS
 * requirement of `readDatabaseTarget`. This is for URLs another layer has
 * already trusted — the Cloudflare `HYPERDRIVE` binding (whose own hop is TLS
 * terminated by Cloudflare) or a validated migration URL — where only the
 * pooling shape decides whether `prepare: false` is needed. An unparsable URL
 * keeps the driver default; `postgres.js` reports the real error when it
 * connects.
 */
export function classifyDatabaseUrl(
  value: string
): Pick<DatabaseConnectionTarget, 'pooled' | 'preparedStatements'> {
  try {
    const hostname = new URL(value).hostname
    const pooled = isTransactionPooledHost(hostname)
    return { pooled, preparedStatements: !pooled }
  } catch {
    return { pooled: false, preparedStatements: true }
  }
}

export function readDatabaseUrl(
  environment: DatabaseEnvironment = process.env,
  key = 'DATABASE_URL'
): string {
  for (const clientKey of CLIENT_DATABASE_KEYS) {
    if (environment[clientKey]) {
      throw new Error(`Database credentials must never be client-exposed through ${clientKey}`)
    }
  }

  const value = environment[key]
  if (!value) {
    throw new Error(`${key} is required`)
  }

  return readDatabaseTarget(value, key).url
}
