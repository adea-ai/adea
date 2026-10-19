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
// host). Cloudflare Hyperdrive and a direct Railway PostgreSQL connection are not
// that shape: Cloudflare documents `prepare: true` (the Postgres.js default) for
// Hyperdrive and warns that `prepare: false` "can cause queries to hang or fail
// intermittently" under its transaction pooling. Only the Neon pooler host keeps
// the conservative unprepared mode.
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

// Postgres.js reduces repeated query parameters last-value-wins and then maps `sslmode` onto its
// `ssl` option, while `URL.searchParams.get` returns the FIRST value. A URL such as
// `?sslmode=require&sslmode=disable` therefore validates as TLS here and connects in plaintext in
// the driver. Any transport parameter that could be read two ways is rejected outright.
const TLS_PARAMETERS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey'] as const

function assertUnambiguousTransport(url: URL, key: string): void {
  for (const name of TLS_PARAMETERS) {
    if (url.searchParams.getAll(name).length > 1) {
      throw new Error(`${key} must not repeat the ${name} parameter`)
    }
  }
  if (url.searchParams.has('sslmode') && url.searchParams.has('ssl')) {
    throw new Error(`${key} must not combine the sslmode and ssl parameters`)
  }
}

/**
 * The connection role a database URL names, and what it means for Postgres.js
 * prepared statements. `pooled` is true only for a host that multiplexes client
 * transactions onto shared backends and is not known to support them (Neon's
 * `-pooler` endpoint); a Hyperdrive or direct connection prepares statements.
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
 * must carry exactly one TLS mode of `require`, `verify-ca` or `verify-full`;
 * loopback hosts may use `sslmode=disable` for local/throwaway databases. A URL
 * that repeats a transport parameter, or names both `sslmode` and `ssl`, is
 * rejected for every host because the driver and this check would disagree on
 * which value applies.
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

  assertUnambiguousTransport(url, key)

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
 * already trusted, such as the Cloudflare `HYPERDRIVE` binding (whose own hop is
 * TLS terminated by Cloudflare) or a validated migration URL. An unparsable URL
 * keeps the driver default; `postgres.js` reports the real error when it
 * connects.
 */
export function classifyDatabaseUrl(
  value: string
): Pick<DatabaseConnectionTarget, 'pooled' | 'preparedStatements'> {
  try {
    const pooled = isTransactionPooledHost(new URL(value).hostname)
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
