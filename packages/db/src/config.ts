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

export function isLoopbackDatabaseHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  return LOOPBACK_HOSTNAMES.has(host) || host.endsWith('.localhost')
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

/** The connection target a database URL names. */
export interface DatabaseConnectionTarget {
  readonly url: string
  readonly hostname: string
  readonly hosted: boolean
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

  return { url: value, hostname, hosted }
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
