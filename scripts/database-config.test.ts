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

  test('requires every connection to reach one database instance', () => {
    // One instance serves the runtime and migration roles. A configuration that points
    // the two connections at two different instances is two databases. The check names
    // no provider.
    expect(() =>
      inspectDatabaseConfiguration({
        ...localEnvironment,
        DATABASE_MIGRATION_URL:
          'postgresql://agent_hq_local_migration:local-password@127.0.0.1:55433/agent_hq?sslmode=disable',
      })
    ).toThrow('must reach the same PostgreSQL instance')
    expect(() =>
      inspectDatabaseConfiguration({
        ...localEnvironment,
        DATABASE_URL_UNPOOLED:
          'postgresql://agent_hq_local_app:local-password@localhost:55432/agent_hq?sslmode=disable',
      })
    ).toThrow('Pooled and unpooled connections must target the same environment')
  })

  test('accepts one instance addressed through a pooled and a direct endpoint', () => {
    // The pull-request database lane addresses one branch through two endpoints: a pooled
    // runtime endpoint and a direct migration endpoint. The health probe runs against
    // exactly that pair, so the check compares the instance and not the literal host.
    // Refusing it would fail the lane before the database query, and refusing it would
    // say nothing about any provider.
    const pooledHost = 'ep-quiet-pond-123456-pooler.us-east-2.aws.example.test'
    const directHost = 'ep-quiet-pond-123456.us-east-2.aws.example.test'
    const result = inspectDatabaseConfiguration({
      DATABASE_URL: `postgresql://adea_dev_app:secret@${pooledHost}/neondb?sslmode=require&connect_timeout=10`,
      DATABASE_URL_UNPOOLED: `postgresql://adea_dev_app:secret@${directHost}/neondb?sslmode=require&connect_timeout=10`,
      DATABASE_MIGRATION_URL: `postgresql://adea_dev_migration:secret@${directHost}/neondb?sslmode=require&connect_timeout=10`,
    })
    expect(result).toEqual({
      database: 'neondb',
      hosted: true,
      migrationRole: 'adea_dev_migration',
      runtimeRole: 'adea_dev_app',
    })
  })

  test('refuses a second instance reached through the same host name', () => {
    // The pooler marker is the only difference the instance comparison forgives. A
    // different branch, a different region and a different port are different
    // instances and stay refused.
    const pooledHost = 'ep-quiet-pond-123456-pooler.us-east-2.aws.example.test'
    for (const migrationHost of [
      'ep-other-654321.us-east-2.aws.example.test',
      'ep-quiet-pond-123456.us-west-2.aws.example.test',
    ]) {
      expect(() =>
        inspectDatabaseConfiguration({
          DATABASE_URL: `postgresql://adea_dev_app:secret@${pooledHost}/neondb?sslmode=require`,
          DATABASE_MIGRATION_URL: `postgresql://adea_dev_migration:secret@${migrationHost}/neondb?sslmode=require`,
        })
      ).toThrow('must reach the same PostgreSQL instance')
    }
    expect(() =>
      inspectDatabaseConfiguration({
        DATABASE_URL: `postgresql://adea_dev_app:secret@${pooledHost}:5432/neondb?sslmode=require`,
        DATABASE_MIGRATION_URL:
          'postgresql://adea_dev_migration:secret@ep-quiet-pond-123456.us-east-2.aws.example.test:5433/neondb?sslmode=require',
      })
    ).toThrow('must reach the same PostgreSQL instance')
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
