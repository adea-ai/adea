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

  return value
}
