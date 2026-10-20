import { describe, expect, test } from 'bun:test'

import { inspectDatabaseConfiguration } from './database-config.mjs'

const localEnvironment = {
  DATABASE_URL:
    'postgresql://agent_hq_local_app:local-password@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_URL_UNPOOLED:
    'postgresql://agent_hq_local_app:local-password@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_MIGRATION_URL:
    'postgresql://agent_hq_local_migration:local-password@127.0.0.1:55432/agent_hq?sslmode=disable',
}

describe('inspectDatabaseConfiguration', () => {
  test('accepts the standard local PostgreSQL configuration without returning credentials', () => {
    const result = inspectDatabaseConfiguration(localEnvironment)

    expect(result).toEqual({
      database: 'agent_hq',
      hosted: false,
      migrationRole: 'agent_hq_local_migration',
      runtimeRole: 'agent_hq_local_app',
    })
    expect(JSON.stringify(result)).not.toContain('local-password')
  })

  test('requires TLS for hosted PostgreSQL connections', () => {
    expect(() =>
      inspectDatabaseConfiguration({
        ...localEnvironment,
        DATABASE_URL:
          'postgresql://agent_hq_prod_app:secret@prod.example.com/agent_hq?sslmode=disable',
      })
    ).toThrow('Hosted DATABASE_URL must require TLS')
  })

  test('rejects a repeated or doubled transport parameter that Postgres.js would read last-wins', () => {
    for (const query of [
      'sslmode=require&sslmode=disable',
      'sslmode=disable&sslmode=require',
      'sslmode=require&ssl=false',
    ]) {
      expect(() =>
        inspectDatabaseConfiguration({
          ...localEnvironment,
          DATABASE_URL: `postgresql://agent_hq_prod_app:secret@prod.example.com/agent_hq?${query}`,
        })
      ).toThrow(/must not (repeat|combine)/)
    }
  })

  test('keeps runtime and migration credentials separate', () => {
    expect(() =>
      inspectDatabaseConfiguration({
        ...localEnvironment,
        DATABASE_MIGRATION_URL: localEnvironment.DATABASE_URL,
      })
    ).toThrow('must use different roles')
  })

  test('rejects client-exposed database credentials', () => {
    expect(() =>
      inspectDatabaseConfiguration({
        ...localEnvironment,
        NEXT_PUBLIC_DATABASE_URL: localEnvironment.DATABASE_URL,
      })
    ).toThrow('must never be client-exposed')
  })

  test('requires every connection to reach one PostgreSQL host', () => {
    // One managed database serves the runtime and migration roles. A configuration that
    // points the two connections at different hosts is two databases, and the provider this
    // deployment has left offered exactly that split with a pooled runtime endpoint and a
    // direct migration endpoint. The check names neither provider.
    expect(() =>
      inspectDatabaseConfiguration({
        ...localEnvironment,
        DATABASE_MIGRATION_URL:
          'postgresql://agent_hq_local_migration:local-password@127.0.0.1:55433/agent_hq?sslmode=disable',
      })
    ).toThrow('must reach the same PostgreSQL host')
    expect(() =>
      inspectDatabaseConfiguration({
        ...localEnvironment,
        DATABASE_URL_UNPOOLED:
          'postgresql://agent_hq_local_app:local-password@localhost:55432/agent_hq?sslmode=disable',
      })
    ).toThrow('must reach the same PostgreSQL host as DATABASE_URL')
  })

  test('accepts one hosted host with separate runtime and migration roles', () => {
    const result = inspectDatabaseConfiguration({
      DATABASE_URL:
        'postgresql://agent_hq_prod_app:secret@db.example.com:5432/agent_hq?sslmode=require',
      DATABASE_URL_UNPOOLED:
        'postgresql://agent_hq_prod_app:secret@db.example.com:5432/agent_hq?sslmode=require',
      DATABASE_MIGRATION_URL:
        'postgresql://agent_hq_prod_migration:secret@db.example.com:5432/agent_hq?sslmode=require',
    })
    expect(result).toEqual({
      database: 'agent_hq',
      hosted: true,
      migrationRole: 'agent_hq_prod_migration',
      runtimeRole: 'agent_hq_prod_app',
    })
  })
})
