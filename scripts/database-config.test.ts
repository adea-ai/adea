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

  test('requires every connection to reach one PostgreSQL instance', () => {
    // One instance serves the runtime and migration roles. The instance is identified by
    // its host, its port and its database name, and all three have to agree. The check
    // names no provider and forgives no host name.
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
    ).toThrow('must reach the same PostgreSQL instance')
  })

  test('accepts a managed deployment and a loopback database addressed exactly', () => {
    // The two shapes this deployment uses: one managed instance reached directly, and the
    // local container. Both address one instance through one host and one port, and the
    // roles are the only thing that differs.
    const managed = inspectDatabaseConfiguration({
      DATABASE_URL:
        'postgresql://agent_hq_prod_app:secret@db.railway.internal:5432/agent_hq?sslmode=require',
      DATABASE_URL_UNPOOLED:
        'postgresql://agent_hq_prod_app:secret@db.railway.internal:5432/agent_hq?sslmode=require',
      DATABASE_MIGRATION_URL:
        'postgresql://agent_hq_prod_migration:secret@db.railway.internal:5432/agent_hq?sslmode=require',
    })
    expect(managed).toEqual({
      database: 'agent_hq',
      hosted: true,
      migrationRole: 'agent_hq_prod_migration',
      runtimeRole: 'agent_hq_prod_app',
    })
    expect(
      inspectDatabaseConfiguration({
        DATABASE_URL:
          'postgresql://agent_hq_prod_app:secret@db.railway.internal:5432/agent_hq?sslmode=require',
        DATABASE_MIGRATION_URL:
          'postgresql://agent_hq_prod_migration:secret@db.railway.internal:5432/agent_hq?sslmode=require',
      })
    ).toEqual(managed)
  })

  test('refuses two different hosts, whatever their names look like', () => {
    // A hostname is a name, not evidence about which server answers it. These pairs are the
    // ones a rewrite rule would have mistaken for one instance: the marker in the middle of
    // a label, the marker twice, and the marker on an unrelated name.
    const runtimeHost = 'evil-pooler.attacker.example.test'
    for (const migrationHost of [
      'evil.attacker.example.test',
      'evil-pooler-pooler.attacker.example.test',
      'attacker.example.test',
    ]) {
      expect(() =>
        inspectDatabaseConfiguration({
          DATABASE_URL: `postgresql://adea_dev_app:secret@${runtimeHost}/external-providerdb?sslmode=require`,
          DATABASE_MIGRATION_URL: `postgresql://adea_dev_migration:secret@${migrationHost}/external-providerdb?sslmode=require`,
        })
      ).toThrow('must reach the same PostgreSQL instance')
    }
  })

  test('refuses a pooled and a direct endpoint of one branch', () => {
    // The hosted branch lane addressed one branch through two endpoint hostnames, and the
    // check that forgave that difference was a host-name rewrite that could not prove the
    // two addresses were one server. The lane is being replaced by the provider-free
    // disposable CI proof, which addresses one instance through one host and one port, so
    // the shape is refused rather than excused.
    const pooledHost = 'ep-quiet-pond-123456-pooler.us-east-2.aws.example.test'
    const directHost = 'ep-quiet-pond-123456.us-east-2.aws.example.test'
    expect(() =>
      inspectDatabaseConfiguration({
        DATABASE_URL: `postgresql://adea_dev_app:secret@${pooledHost}/external-providerdb?sslmode=require`,
        DATABASE_MIGRATION_URL: `postgresql://adea_dev_migration:secret@${directHost}/external-providerdb?sslmode=require`,
      })
    ).toThrow('must reach the same PostgreSQL instance')
    // The other way round is refused the same way.
    expect(() =>
      inspectDatabaseConfiguration({
        DATABASE_URL: `postgresql://adea_dev_app:secret@${directHost}/external-providerdb?sslmode=require`,
        DATABASE_MIGRATION_URL: `postgresql://adea_dev_migration:secret@${directHost}/external-providerdb?sslmode=require`,
        DATABASE_URL_UNPOOLED: `postgresql://adea_dev_app:secret@${pooledHost}/external-providerdb?sslmode=require`,
      })
    ).toThrow('must reach the same PostgreSQL instance')
  })

  test('refuses two ports on one host', () => {
    // One host can serve two instances on two ports. The port is part of the identity.
    const host = 'db.railway.internal'
    expect(() =>
      inspectDatabaseConfiguration({
        DATABASE_URL: `postgresql://adea_dev_app:secret@${host}:5432/external-providerdb?sslmode=require`,
        DATABASE_MIGRATION_URL: `postgresql://adea_dev_migration:secret@${host}:5433/external-providerdb?sslmode=require`,
      })
    ).toThrow('must reach the same PostgreSQL instance')
    expect(() =>
      inspectDatabaseConfiguration({
        DATABASE_URL: `postgresql://adea_dev_app:secret@${host}:5432/external-providerdb?sslmode=require`,
        DATABASE_MIGRATION_URL: `postgresql://adea_dev_migration:secret@${host}:5432/external-providerdb?sslmode=require`,
        DATABASE_URL_UNPOOLED: `postgresql://adea_dev_app:secret@${host}:5433/external-providerdb?sslmode=require`,
      })
    ).toThrow('must reach the same PostgreSQL instance')
  })

  test('refuses one host and one port carrying different databases', () => {
    expect(() =>
      inspectDatabaseConfiguration({
        DATABASE_URL:
          'postgresql://adea_dev_app:secret@db.railway.internal:5432/external-providerdb?sslmode=require',
        DATABASE_MIGRATION_URL:
          'postgresql://adea_dev_migration:secret@db.railway.internal:5432/other?sslmode=require',
      })
    ).toThrow('must target the same database')
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
