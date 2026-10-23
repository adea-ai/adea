import { Client } from 'pg'

export type AuthEnvironment = Record<string, string | undefined>

function isLoopback(hostname: string) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  )
}

/**
 * True when a host can be reached without transport encryption: loopback (a
 * developer machine or a sidecar), or a Unix domain socket, whose host is a
 * filesystem path beginning with `/`. Any other host is remote and must be
 * reached over TLS.
 */
function isLocalDatabaseHost(host: string): boolean {
  return host.startsWith('/') || isLoopback(host)
}

type PostgresTarget = Readonly<{
  host: string
  ssl: boolean
}>

// TLS query parameters that must never carry an empty value. `pg` treats an
// empty `sslmode`/`sslcert`/`sslkey`/`sslrootcert` as absent, so a URL that
// looks like it opts into TLS can silently connect in the clear.
const NON_EMPTY_TLS_PARAMETERS = ['sslcert', 'sslkey', 'sslrootcert', 'sslmode'] as const

function assertNonEmptyTlsParameters(url: URL): void {
  for (const name of NON_EMPTY_TLS_PARAMETERS) {
    if (url.searchParams.get(name) === '') {
      throw new Error(`AUTH_DATABASE_URL must not set an empty ${name}`)
    }
  }
}

/**
 * Reads the host and SSL state the pinned `pg` client — and therefore the pool
 * this service builds — will actually connect with, then rejects the forms that
 * must never reach a hosted database:
 *
 * - empty TLS parameters, which `pg` ignores rather than enables;
 * - `sslmode=no-verify` (or any other setting that disables certificate
 *   verification);
 * - an effective plaintext connection to a non-loopback host.
 *
 * It asks `pg` itself for the effective settings rather than re-implementing
 * `pg-connection-string`'s parsing, so last-value-wins `sslmode`,
 * `sslmode=disable` overriding `ssl=true`, and a query `host` override all
 * resolve exactly as the driver resolves them. No socket is opened.
 */
function readPostgresTarget(url: URL): PostgresTarget {
  assertNonEmptyTlsParameters(url)
  if (url.searchParams.get('sslmode') === 'no-verify') {
    throw new Error('AUTH_DATABASE_URL must not disable TLS certificate verification')
  }

  // `pg` parses the connection string in the Client constructor; reading its
  // connection parameters is the effective configuration with no network.
  const client = new Client({ connectionString: url.toString() })
  const parameters = (
    client as unknown as {
      connectionParameters: {
        host?: string
        ssl?: boolean | { rejectUnauthorized?: boolean }
      }
    }
  ).connectionParameters
  const ssl = parameters.ssl
  if (typeof ssl === 'object' && ssl !== null && ssl.rejectUnauthorized === false) {
    throw new Error('AUTH_DATABASE_URL must not disable TLS certificate verification')
  }
  return { host: parameters.host ?? '', ssl: Boolean(ssl) }
}

export function normalizeTrustedTarget(value: string): string {
  if (value.includes('*')) {
    throw new Error('Auth trusted origins must not contain a wildcard')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid auth trusted origin: ${value}`)
  }

  if (url.username || url.password) {
    throw new Error('Auth trusted origins must not contain credentials')
  }
  if (url.hash || url.search) {
    throw new Error('Auth trusted origins must not contain query strings or fragments')
  }

  if (url.protocol === 'https:') {
    return url.origin
  }
  if (url.protocol === 'http:' && isLoopback(url.hostname)) {
    return url.origin
  }
  if (url.protocol === 'adea:') {
    return `${url.protocol}//${url.host}${url.pathname}`
  }

  throw new Error('Auth trusted origins require HTTPS, loopback HTTP, or adea callbacks')
}

export type BetterAuthConfig = Readonly<{
  baseUrl: string
  /** True when {@link databaseUrl} must be opened over TLS (any non-loopback host). */
  databaseRequiresTls: boolean
  databaseUrl: string
  emailVerificationRequired: boolean
  google?: Readonly<{ clientId: string; clientSecret: string }>
  secureCookies: boolean
  secret: string
  sessionExpiresInSeconds: number
  sessionUpdateAgeSeconds: number
  trustedOrigins: readonly string[]
}>

function readPositiveSeconds(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of seconds`)
  }
  return value
}

function readBoolean(raw: string | undefined, name: string, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = raw.trim().toLowerCase()
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`${name} must be true or false`)
}

/**
 * Reads the self-hosted Better Auth configuration for a fresh deployment on a
 * managed PostgreSQL (Railway) instance.
 */
export function readBetterAuthConfig(environment: AuthEnvironment = process.env): BetterAuthConfig {
  const rawBaseUrl = environment.AUTH_BASE_URL
  if (!rawBaseUrl) throw new Error('AUTH_BASE_URL is required')

  let baseUrl: URL
  try {
    baseUrl = new URL(rawBaseUrl)
  } catch {
    throw new Error('AUTH_BASE_URL must be a valid URL')
  }
  if (
    baseUrl.protocol !== 'https:' &&
    !(baseUrl.protocol === 'http:' && isLoopback(baseUrl.hostname))
  ) {
    throw new Error('AUTH_BASE_URL must use HTTPS outside loopback development')
  }

  const secret = environment.AUTH_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET must contain at least 32 characters')
  }

  const databaseUrl = environment.AUTH_DATABASE_URL
  if (!databaseUrl) throw new Error('AUTH_DATABASE_URL is required')
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error('AUTH_DATABASE_URL must be a postgres:// connection string')
  }
  let database: URL
  try {
    database = new URL(databaseUrl)
  } catch {
    throw new Error('AUTH_DATABASE_URL must be a valid URL')
  }
  const target = readPostgresTarget(database)
  if (!isLocalDatabaseHost(target.host) && !target.ssl) {
    throw new Error(
      'AUTH_DATABASE_URL must require TLS (sslmode=require, verify-ca, or verify-full) outside loopback'
    )
  }

  const rawOrigins = environment.AUTH_TRUSTED_ORIGINS
  if (!rawOrigins) throw new Error('AUTH_TRUSTED_ORIGINS is required')
  const trustedOrigins = [
    ...new Set(rawOrigins.split(',').map((value) => normalizeTrustedTarget(value.trim()))),
  ]
  if (trustedOrigins.length === 0) throw new Error('AUTH_TRUSTED_ORIGINS must not be empty')

  const googleClientId = environment.GOOGLE_CLIENT_ID
  const googleClientSecret = environment.GOOGLE_CLIENT_SECRET
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together')
  }

  const secureCookies = readBoolean(
    environment.AUTH_SECURE_COOKIES,
    'AUTH_SECURE_COOKIES',
    baseUrl.protocol === 'https:'
  )
  const loopbackDevelopment = baseUrl.protocol === 'http:' && isLoopback(baseUrl.hostname)
  if (!secureCookies && !loopbackDevelopment) {
    throw new Error('AUTH_SECURE_COOKIES must not be disabled outside loopback development')
  }

  return Object.freeze({
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    databaseRequiresTls: !isLocalDatabaseHost(target.host),
    databaseUrl,
    // Mailbox proof is required by default: an unverified address must not carry
    // email-based authority (allowlists, invitations). A deployment can only turn
    // this off deliberately.
    emailVerificationRequired: readBoolean(
      environment.AUTH_EMAIL_VERIFICATION_REQUIRED,
      'AUTH_EMAIL_VERIFICATION_REQUIRED',
      true
    ),
    ...(googleClientId && googleClientSecret
      ? { google: Object.freeze({ clientId: googleClientId, clientSecret: googleClientSecret }) }
      : {}),
    // Secure cookies are the default; only loopback development over plain HTTP
    // may downgrade them.
    secureCookies,
    secret,
    sessionExpiresInSeconds: readPositiveSeconds(
      environment.AUTH_SESSION_EXPIRES_IN_SECONDS,
      'AUTH_SESSION_EXPIRES_IN_SECONDS',
      60 * 60 * 24 * 7
    ),
    sessionUpdateAgeSeconds: readPositiveSeconds(
      environment.AUTH_SESSION_UPDATE_AGE_SECONDS,
      'AUTH_SESSION_UPDATE_AGE_SECONDS',
      60 * 60 * 24
    ),
    trustedOrigins: Object.freeze(trustedOrigins),
  })
}
