import { describe, expect, test } from 'bun:test'

import { AuthSchemaInitError, readAuthSchemaInitConfig } from '../../src/schema-init'

const base = {
  AUTH_BASE_URL: 'https://auth.example.test',
  AUTH_SECRET: 'unit-schema-init-secret-at-least-thirty-two-characters',
  AUTH_TRUSTED_ORIGINS: 'https://app.example.test',
}
const localMigrationUrl = 'postgresql://auth_owner:local-only@127.0.0.1:5432/adea'

function failureOf(run: () => unknown): AuthSchemaInitError {
  try {
    run()
  } catch (error) {
    if (error instanceof AuthSchemaInitError) return error
    throw error
  }
  throw new Error('expected readAuthSchemaInitConfig to throw')
}

describe('explicit schema initialization inputs', () => {
  test('reads only the migration URL, never the runtime AUTH_DATABASE_URL', () => {
    const config = readAuthSchemaInitConfig({
      ...base,
      AUTH_DATABASE_URL: 'postgres://runtime_user:runtime-secret@db.example.test:5432/adea',
      AUTH_MIGRATION_DATABASE_URL: localMigrationUrl,
    })

    expect(config.databaseUrl).toBe(localMigrationUrl)
    expect(config.databaseRequiresTls).toBe(false)
  })

  test('requires the migration URL and names it when it is missing', () => {
    const error = failureOf(() =>
      readAuthSchemaInitConfig({
        ...base,
        AUTH_DATABASE_URL: localMigrationUrl,
      })
    )

    expect(error.stage).toBe('config')
    expect(error.message).toBe('AUTH_MIGRATION_DATABASE_URL is required')
  })

  test('refuses a remote migration URL without TLS, naming the migration variable', () => {
    const error = failureOf(() =>
      readAuthSchemaInitConfig({
        ...base,
        AUTH_MIGRATION_DATABASE_URL: 'postgresql://auth_owner:remote-secret@db.example.test/adea',
      })
    )

    expect(error.stage).toBe('config')
    expect(error.message).toContain('AUTH_MIGRATION_DATABASE_URL must require TLS')
    expect(error.message).not.toContain('AUTH_DATABASE_URL must')
    expect(error.message).not.toContain('remote-secret')
  })

  test('applies the runtime TLS and verification rules to the migration URL', () => {
    const error = failureOf(() =>
      readAuthSchemaInitConfig({
        ...base,
        AUTH_MIGRATION_DATABASE_URL:
          'postgresql://auth_owner:secret@db.example.test/adea?sslmode=no-verify',
      })
    )

    expect(error.stage).toBe('config')
    expect(error.message).toContain('AUTH_MIGRATION_DATABASE_URL')
    expect(error.message).not.toContain('secret')
  })

  test('rejects non-PostgreSQL schemes before any connection is attempted', () => {
    const error = failureOf(() =>
      readAuthSchemaInitConfig({
        ...base,
        AUTH_MIGRATION_DATABASE_URL: 'mysql://auth_owner:secret@127.0.0.1/adea',
      })
    )

    expect(error.stage).toBe('config')
    expect(error.message).toBe(
      'AUTH_DATABASE_URL must be a postgres:// connection string'.replaceAll(
        'AUTH_DATABASE_URL',
        'AUTH_MIGRATION_DATABASE_URL'
      )
    )
  })
})
