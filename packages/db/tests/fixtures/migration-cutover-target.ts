/**
 * Confined disposable database targets for the cutover rehearsals.
 *
 * A rehearsal may only ever touch a disposable instance it owns, and the
 * capture provisioning URL is inherited from the environment. It is therefore
 * validated before use: a loopback host, no inherited startup or identity
 * option, no duplicate or percent-encoded parameter, and a canonical
 * connection URL that is rebuilt from the validated parts instead of being
 * mutated. The server's own database and user identity is then checked before
 * anything is migrated, so an instance that answers on another identity is
 * refused instead of written to.
 *
 * This module is pure: it never opens a connection. `assertServerIdentity`
 * takes a connection that the caller already opened.
 */

/** The TLS modes a disposable target may ask for. */
export type DisposableSslMode = 'disable' | 'prefer' | 'require'

/** The validated identity of one local disposable PostgreSQL target. */
export type LocalDisposableTarget = Readonly<{
  host: string
  port: number
  user: string
  password: string
  adminDatabase: string
  /**
   * The TLS mode the target asked for, kept exactly as it was requested. A
   * target that asked for a stronger mode is never silently downgraded, and a
   * target that asked for none keeps the driver's own default.
   */
  sslMode?: DisposableSslMode
}>

/** The only parameter that may survive onto a connection URL. */
const ALLOWED_PARAMETERS: readonly string[] = ['sslmode']

/** The TLS modes this target may request. */
const SUPPORTED_SSL_MODES: readonly DisposableSslMode[] = ['disable', 'prefer', 'require']

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost'])

/** A scratch database name: lowercase, digits and underscores only. */
const SCRATCH_NAME = /^[a-z0-9_]{1,63}$/

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return LOOPBACK_HOSTS.has(host)
}

/**
 * Validate an inherited capture URL and return its canonical identity.
 *
 * Every parameter is inspected twice: in its raw form and in its decoded
 * form. A percent-encoded key, an upper-case key, a duplicate key, or any
 * parameter outside the allowlist is refused, so a startup option
 * (`options`, `search_path`) or an identity override (`host`, `port`,
 * `dbname`, `user`) can never reach the server through an inherited URL.
 */
export function parseLocalDisposableTarget(raw: string): LocalDisposableTarget {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('the disposable database target is missing')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch (error) {
    throw new Error('the disposable database target is not a URL', { cause: error })
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('the disposable database target must be a PostgreSQL URL')
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(
      `the disposable database target must be a loopback address, not "${url.hostname}"`
    )
  }
  const seen = new Set<string>()
  let requestedSslMode: DisposableSslMode | undefined
  for (const pair of url.search.replace(/^\?/, '').split('&')) {
    if (!pair) continue
    const rawKey = pair.split('=')[0] ?? ''
    let key = rawKey
    try {
      key = decodeURIComponent(rawKey)
    } catch (error) {
      throw new Error('the disposable database target has an unreadable parameter name', {
        cause: error,
      })
    }
    const normalized = key.trim().toLowerCase()
    if (normalized !== rawKey.trim().toLowerCase()) {
      throw new Error(
        `the disposable database target must not carry an encoded parameter name ("${rawKey}")`
      )
    }
    if (seen.has(normalized)) {
      throw new Error(
        `the disposable database target must not repeat the parameter "${normalized}"`
      )
    }
    seen.add(normalized)
    if (!ALLOWED_PARAMETERS.includes(normalized)) {
      throw new Error(`the disposable database target must not carry the parameter "${normalized}"`)
    }
    if (normalized === 'sslmode') {
      const rawValue = pair.slice(rawKey.length + 1)
      let value = rawValue
      try {
        value = decodeURIComponent(rawValue)
      } catch (error) {
        throw new Error('the disposable database target has an unreadable parameter value', {
          cause: error,
        })
      }
      const mode = value.trim().toLowerCase()
      if (!(SUPPORTED_SSL_MODES as readonly string[]).includes(mode)) {
        throw new Error(`the disposable database target must not request the TLS mode "${value}"`)
      }
      requestedSslMode = mode as DisposableSslMode
    }
  }
  const port = url.port ? Number(url.port) : 5432
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('the disposable database target has an unusable port')
  }
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!user) throw new Error('the disposable database target has no user')
  const adminDatabase = url.pathname.replace(/^\//, '')
  if (!adminDatabase) throw new Error('the disposable database target has no database')
  // The requested mode is kept as it was asked for. A target that named none
  // keeps the driver's own default instead of being downgraded here.
  return Object.freeze({
    host: url.hostname,
    port,
    user,
    password,
    adminDatabase,
    ...(requestedSslMode ? { sslMode: requestedSslMode } : {}),
  })
}

/**
 * Build the connection URL for one database on a validated target.
 *
 * The URL is rebuilt from the validated parts, so nothing the environment
 * carried — no startup option, no identity override, no second host — can
 * reach the server.
 */
export function canonicalTargetUrl(target: LocalDisposableTarget, database: string): string {
  if (!SCRATCH_NAME.test(database)) {
    throw new Error(`the disposable database name "${database}" is not a plain lowercase name`)
  }
  const url = new URL(
    `postgresql://${encodeURIComponent(target.user)}:${encodeURIComponent(target.password)}@${target.host}:${target.port}/${encodeURIComponent(database)}`
  )
  url.search = ''
  if (target.sslMode) url.searchParams.set('sslmode', target.sslMode)
  return url.toString()
}

/** A scratch database name is refused unless it carries the owned prefix. */
export function assertScratchDatabaseName(database: string, prefix: string): void {
  if (!database.startsWith(prefix)) {
    throw new Error(`Refusing to create or drop "${database}": scratch names need ${prefix}`)
  }
  if (!SCRATCH_NAME.test(database)) {
    throw new Error(`Refusing to create or drop "${database}": the name is not a plain name`)
  }
}

/**
 * Confirm the server reports the intended database and user.
 *
 * The check runs before any migration: an instance that answers on another
 * identity is refused instead of written to.
 */
export async function assertServerIdentity(
  connection: { execute(query: unknown): Promise<readonly unknown[]> },
  expected: Readonly<{ database: string; user: string }>
): Promise<void> {
  const rows = await connection.execute(
    'select current_database() as database, current_user as user'
  )
  const row = rows[0] as { database?: unknown; user?: unknown } | undefined
  if (!row || row.database !== expected.database || row.user !== expected.user) {
    throw new Error(
      'the disposable database server did not report the expected database and user identity'
    )
  }
}
