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
    role: decodeURIComponent(url.username),
  }
}

function normalizedPoolerHost(hostname) {
  return hostname.replace('-pooler.', '.')
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
  if (unpooled) {
    if (unpooled.role !== runtime.role || unpooled.database !== runtime.database) {
      throw new Error('DATABASE_URL_UNPOOLED must use the runtime role and database')
    }
    if (normalizedPoolerHost(unpooled.hostname) !== normalizedPoolerHost(runtime.hostname)) {
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
