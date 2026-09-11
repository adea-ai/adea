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

function normalizedNeonHost(hostname) {
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
    if (normalizedNeonHost(unpooled.hostname) !== normalizedNeonHost(runtime.hostname)) {
      throw new Error('Pooled and unpooled connections must target the same environment')
    }
  }

  if (runtime.hostname.endsWith('.neon.tech')) {
    if (!runtime.hostname.includes('-pooler.')) {
      throw new Error('Hosted Neon DATABASE_URL must use the pooled endpoint')
    }
    if (migration.hostname.includes('-pooler.')) {
      throw new Error('Hosted Neon DATABASE_MIGRATION_URL must use the unpooled endpoint')
    }
  }

  return Object.freeze({
    database: runtime.database,
    hosted: runtime.hosted,
    migrationRole: migration.role,
    runtimeRole: runtime.role,
  })
}
