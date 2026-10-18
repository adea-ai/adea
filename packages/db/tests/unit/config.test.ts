import { describe, expect, test } from 'bun:test'

import { classifyDatabaseUrl, readDatabaseTarget, readDatabaseUrl } from '../../src/config'

describe('database configuration', () => {
  test('requires a server-side PostgreSQL URL', () => {
    expect(() => readDatabaseUrl({})).toThrow('DATABASE_URL is required')
    expect(() => readDatabaseUrl({ DATABASE_URL: 'https://example.com' })).toThrow('PostgreSQL')
  })

  test('rejects a URL without role, password, host or database', () => {
    expect(() => readDatabaseUrl({ DATABASE_URL: 'postgresql://localhost/agent_hq' })).toThrow(
      'must include role, password, host, and database'
    )
    expect(() =>
      readDatabaseUrl({ DATABASE_URL: 'postgresql://app:secret@db.example.com/' })
    ).toThrow('must include role, password, host, and database')
  })

  test('rejects client-prefixed database credentials', () => {
    expect(() =>
      readDatabaseUrl({
        DATABASE_URL: 'postgresql://app:secret@localhost:5432/agent_hq',
        NEXT_PUBLIC_DATABASE_URL: 'postgresql://leaked:secret@localhost/db',
      })
    ).toThrow('client-exposed')
  })

  test('requires an explicit TLS mode for a hosted connection', () => {
    expect(() =>
      readDatabaseUrl({ DATABASE_URL: 'postgresql://app:secret@db.example.com:5432/agent_hq' })
    ).toThrow('Hosted DATABASE_URL must require TLS')
    expect(() =>
      readDatabaseUrl({
        DATABASE_URL: 'postgresql://app:secret@db.example.com:5432/agent_hq?sslmode=disable',
      })
    ).toThrow('Hosted DATABASE_URL must require TLS')
    // `prefer` may fall back to plaintext, so it is not a strict TLS mode.
    expect(() =>
      readDatabaseUrl({
        DATABASE_URL: 'postgresql://app:secret@db.example.com:5432/agent_hq?sslmode=prefer',
      })
    ).toThrow('Hosted DATABASE_URL must require TLS')
  })

  test('accepts every strict TLS mode for a hosted connection', () => {
    for (const sslmode of ['require', 'verify-ca', 'verify-full']) {
      const url = `postgresql://app:secret@db.example.com:5432/agent_hq?sslmode=${sslmode}`
      expect(readDatabaseUrl({ DATABASE_URL: url })).toBe(url)
    }
  })

  test('allows loopback connections without TLS', () => {
    const url = 'postgresql://app:secret@127.0.0.1:55432/agent_hq?sslmode=disable'
    expect(readDatabaseUrl({ DATABASE_URL: url })).toBe(url)
    expect(
      readDatabaseUrl({ DATABASE_URL: 'postgresql://app:secret@localhost:5432/agent_hq' })
    ).toBe('postgresql://app:secret@localhost:5432/agent_hq')
  })
})

const hostedUrl = (host: string) => `postgresql://app:secret@${host}:5432/agent_hq?sslmode=require`

describe('connection role qualification', () => {
  test('reports host, hosted and URL through readDatabaseTarget', () => {
    const target = readDatabaseTarget(hostedUrl('db.example.com'))
    expect(target).toEqual({
      url: hostedUrl('db.example.com'),
      hostname: 'db.example.com',
      hosted: true,
      pooled: false,
      preparedStatements: true,
    })
  })

  test('treats a Neon pooled endpoint as transaction-pooled and keeps prepare: false', () => {
    const target = readDatabaseTarget(hostedUrl('ep-cool-1234-pooler.us-east-2.aws.neon.tech'))
    expect(target.pooled).toBe(true)
    expect(target.preparedStatements).toBe(false)
  })

  test('treats a Neon direct endpoint and a Hyperdrive host as prepared-statement safe', () => {
    for (const host of [
      'ep-cool-1234.us-east-2.aws.neon.tech',
      'adea-db.hyperdrive.cloudflare.com',
      'abc123.proxy.rlwy.net',
    ]) {
      const target = readDatabaseTarget(hostedUrl(host))
      expect(target.pooled).toBe(false)
      expect(target.preparedStatements).toBe(true)
    }
  })

  test('classifyDatabaseUrl drops the hosted TLS requirement but keeps the pooling shape', () => {
    // Hyperdrive's binding string need not carry sslmode; it still keeps prepared statements.
    expect(
      classifyDatabaseUrl('postgresql://app:secret@db.hyperdrive.cloudflare.com:5432/agent_hq')
    ).toEqual({ pooled: false, preparedStatements: true })
    expect(
      classifyDatabaseUrl('postgresql://app:secret@ep-1-pooler.us-east-2.aws.neon.tech/agent_hq')
    ).toEqual({ pooled: true, preparedStatements: false })
    // An unparsable URL cannot be a known pooler; keep the driver default.
    expect(classifyDatabaseUrl('not-a-url')).toEqual({ pooled: false, preparedStatements: true })
  })
})
