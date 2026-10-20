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
]

function readConnection(environment, name) {
  const rawValue = environment[name]
  if (!rawValue) {
    throw new Error(`${name} is required`)
  }

  let url
  try {
    url = new URL(rawValue)
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`)
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must use the PostgreSQL protocol`)
  }
  if (!url.username || !url.password || !url.hostname || url.pathname === '/') {
    throw new Error(`${name} must include role, password, host, and database`)
  }

  // Postgres.js reads repeated query parameters last-value-wins while searchParams.get() returns
  // the first, so a repeated or doubly-named transport parameter is rejected rather than guessed.
  for (const param of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey']) {
    if (url.searchParams.getAll(param).length > 1) {
      throw new Error(`${name} must not repeat the ${param} parameter`)
    }
  }
  if (url.searchParams.has('sslmode') && url.searchParams.has('ssl')) {
    throw new Error(`${name} must not combine the sslmode and ssl parameters`)
  }

  const localHosts = new Set(['127.0.0.1', '::1', 'localhost'])
  const hosted = !localHosts.has(url.hostname)
  const sslMode = url.searchParams.get('sslmode')
  if (hosted && !['require', 'verify-ca', 'verify-full'].includes(sslMode ?? '')) {
    throw new Error(`Hosted ${name} must require TLS`)
  }

  return {
    database: url.pathname.slice(1),
    hosted,
    hostname: url.hostname,
    port: url.port || '5432',
    role: decodeURIComponent(url.username),
  }
}

/**
 * True when two connections address the same PostgreSQL instance.
 *
 * The instance's identity is the host, the port and the database name: one host
 * and port is one server, and the database name is the database within it. Two
 * connections that agree on all three address the same instance.
 *
 * Two hostnames are never equal by resemblance. A hostname is a name, not
 * evidence about which server answers it, so the provider this deployment has
 * left — which served one instance through two endpoint hostnames, a pooled
 * endpoint and a direct one — is two addresses, not one instance, and the
 * runtime does not forgive the difference by rewriting the name. Rewriting a
 * hostname cannot prove that two addresses are one server, and a rewrite rule
 * would accept any lookalike: `evil-pooler.example.test` and
 * `evil.example.test` are not one server, whatever their names suggest.
 *
 * A deployment that needs one instance reached through two endpoints has to
 * say so with an explicitly validated contract, not with a name pattern.
 */
function sameInstance(one, other) {
  return (
    one.hostname === other.hostname && one.port === other.port && one.database === other.database
  )
}

export function inspectDatabaseConfiguration(environment = process.env) {
  for (const key of CLIENT_DATABASE_KEYS) {
    if (environment[key]) {
      throw new Error(`Database credentials must never be client-exposed through ${key}`)
    }
  }

  const runtime = readConnection(environment, 'DATABASE_URL')
  const migration = readConnection(environment, 'DATABASE_MIGRATION_URL')
  const unpooled = environment.DATABASE_URL_UNPOOLED
    ? readConnection(environment, 'DATABASE_URL_UNPOOLED')
    : undefined

  if (runtime.role === migration.role) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must use different roles')
  }
  if (!runtime.role.endsWith('_app') || !migration.role.endsWith('_migration')) {
    throw new Error('Database roles must use the _app and _migration conventions')
  }
  if (runtime.database !== migration.database) {
    throw new Error('Runtime and migration connections must target the same database')
  }
  if (runtime.hosted !== migration.hosted) {
    throw new Error('Runtime and migration connections must target the same environment type')
  }
  // Every role must reach one PostgreSQL instance, and the instance is identified
  // exactly. The provider-free lanes each address one instance through one host and
  // one port: the managed deployment, the local container and the disposable CI
  // proof. The hosted branch lane addressed one branch through two endpoint
  // hostnames, and it is being replaced by the provider-free CI proof; that
  // replacement and this rule are integrated together.
  if (!sameInstance(runtime, migration)) {
    throw new Error(
      'Runtime and migration connections must reach the same PostgreSQL instance: the same host, port and database'
    )
  }
  if (unpooled) {
    if (unpooled.role !== runtime.role || unpooled.database !== runtime.database) {
      throw new Error('DATABASE_URL_UNPOOLED must use the runtime role and database')
    }
    if (!sameInstance(unpooled, runtime)) {
      throw new Error(
        'DATABASE_URL_UNPOOLED must reach the same PostgreSQL instance as DATABASE_URL: the same host, port and database'
      )
    }
  }

  return Object.freeze({
    database: runtime.database,
    hosted: runtime.hosted,
    migrationRole: migration.role,
    runtimeRole: runtime.role,
  })
}
