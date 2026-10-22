import { describe, expect, test } from 'bun:test'
import { X509Certificate, createHash } from 'node:crypto'

import { migrationConnection, PRODUCTION_MIGRATION_TARGET } from '../../src/migration-target'
import { createDatabase } from '../../src/connection'

const approved =
  'postgresql://adea_prod_migration:synthetic-password@altaria.proxy.rlwy.net:44407/railway?sslmode=verify-full'

describe('reviewed production migration target', () => {
  test('pins the transport, peer identity and authenticated CA independently', async () => {
    const target = migrationConnection({ DATABASE_MIGRATION_URL: approved })
    expect(target.options.tls?.rejectUnauthorized).toBe(true)
    expect(target.options.tls?.servername).toBe('postgres.railway.internal')
    expect(
      createHash('sha256').update(new X509Certificate(target.options.tls!.ca).raw).digest('hex')
    ).toBe(PRODUCTION_MIGRATION_TARGET.caSha256)
    const connection = createDatabase(target.connectionUrl, target.options)
    try {
      expect(connection.client.options.ssl).toEqual(target.options.tls)
    } finally {
      await connection.close()
    }
  })
  test('refuses changed database, role, host, port and TLS settings before connection', () => {
    for (const change of [
      (u: URL) => {
        u.hostname = 'unreviewed.example.invalid'
      },
      (u: URL) => {
        u.port = '5432'
      },
      (u: URL) => {
        u.username = 'postgres'
      },
      (u: URL) => {
        u.pathname = '/postgres'
      },
      (u: URL) => {
        u.searchParams.set('sslmode', 'require')
      },
      (u: URL) => {
        u.searchParams.set('ssl', 'false')
      },
      (u: URL) => {
        u.searchParams.set('host', 'unreviewed.example.invalid')
      },
      (u: URL) => {
        u.hash = 'unexpected'
      },
    ]) {
      const url = new URL(approved)
      change(url)
      expect(() => migrationConnection({ DATABASE_MIGRATION_URL: url.toString() })).toThrow()
    }
  })
  test('keeps disposable loopback migrations separate from production', () => {
    expect(
      migrationConnection({
        DATABASE_MIGRATION_URL:
          'postgresql://fixture:synthetic@127.0.0.1:15432/fixture?sslmode=disable',
      }).options
    ).toEqual({})
  })
})
