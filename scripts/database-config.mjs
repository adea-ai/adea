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
 * A transaction-pooled endpoint and its direct endpoint are two addresses for one
 * database instance, so the pooler marker is removed before two hosts are compared.
 * The comparison names no provider: the same rule serves a pooled edge endpoint, a
 * direct endpoint and the loopback database.
 */
function normalizedPoolerHost(hostname) {
  return hostname.replace('-pooler.', '.')
}

/**
 * True when two connections address the same database instance. One instance can be
 * reached through a pooled endpoint and through its direct endpoint, so the address
 * is compared without the pooler marker, and the port is compared exactly: two
 * instances can share a host on different ports.
 */
function sameDatabaseInstance(one, other) {
  return (
    normalizedPoolerHost(one.hostname) === normalizedPoolerHost(other.hostname) &&
    one.port === other.port
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
  // Every role must reach one database instance. The pull-request database lane
  // addresses one branch through two endpoints — a pooled runtime endpoint and a
  // direct migration endpoint — and a managed deployment addresses one instance
  // directly, so the instance is compared rather than the literal host. Comparing the
  // literal host would refuse the lane's own two-endpoint shape, and refusing it
  // would say nothing about any provider.
  if (!sameDatabaseInstance(runtime, migration)) {
    throw new Error('Runtime and migration connections must reach the same PostgreSQL instance')
  }
  if (unpooled) {
    if (unpooled.role !== runtime.role || unpooled.database !== runtime.database) {
      throw new Error('DATABASE_URL_UNPOOLED must use the runtime role and database')
    }
    if (!sameDatabaseInstance(unpooled, runtime)) {
      throw new Error('Pooled and unpooled connections must target the same environment')
    }
  }

  return Object.freeze({
    database: runtime.database,
    hosted: runtime.hosted,
    migrationRole: migration.role,
    runtimeRole: runtime.role,
  })
}
