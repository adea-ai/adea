import { describe, expect, test } from 'bun:test'
import postgres from 'postgres'

import { readDatabaseTarget, readDatabaseUrl } from '../../src/config'

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

const driverSsl = (url: string) => {
  // postgres(url) is lazy: parsing the options opens no socket.
  const sql = postgres(url)
  try {
    return sql.options.ssl
  } finally {
    void sql.end({ timeout: 0 })
  }
}

describe('connection target qualification', () => {
  test('reports host, hosted and URL through readDatabaseTarget', () => {
    expect(readDatabaseTarget(hostedUrl('db.example.com'))).toEqual({
      url: hostedUrl('db.example.com'),
      hostname: 'db.example.com',
      hosted: true,
      preparedStatements: true,
    })
    expect(
      readDatabaseTarget('postgresql://app:secret@127.0.0.1:5432/agent_hq?sslmode=disable')
    ).toMatchObject({ hosted: false })
  })

  test('accepts each hosted TLS mode exactly once, and the driver then enables TLS', () => {
    for (const mode of ['require', 'verify-ca', 'verify-full']) {
      const url = `postgresql://app:secret@db.example.com:5432/agent_hq?sslmode=${mode}`
      expect(readDatabaseTarget(url).hosted).toBe(true)
      expect(driverSsl(url)).toBeTruthy()
    }
  })

  const ambiguous = [
    // The first value passes a first-value check; Postgres.js applies the last one.
    'sslmode=require&sslmode=disable',
    'sslmode=disable&sslmode=require',
    'sslmode=require&sslmode=require',
    'sslmode=require&ssl=false',
    'ssl=true&sslmode=require',
    'sslmode=verify-full&sslrootcert=a&sslrootcert=b',
  ]

  test('the driver really reads a repeated sslmode last-value-wins (the hazard)', () => {
    const url =
      'postgresql://app:secret@db.example.com:5432/agent_hq?sslmode=require&sslmode=disable'
    // URLSearchParams.get() sees "require"; Postgres.js connects without TLS.
    expect(new URL(url).searchParams.get('sslmode')).toBe('require')
    expect(driverSsl(url)).toBe(false)
  })

  test('rejects repeated or doubly-named transport parameters for hosted hosts', () => {
    for (const query of ambiguous) {
      const url = `postgresql://app:secret@db.example.com:5432/agent_hq?${query}`
      expect(() => readDatabaseTarget(url)).toThrow(/must not (repeat|combine)/)
      expect(() => readDatabaseUrl({ DATABASE_URL: url })).toThrow(/must not (repeat|combine)/)
    }
  })

  test('rejects the same ambiguity on a loopback host', () => {
    expect(() =>
      readDatabaseTarget(
        'postgresql://app:secret@localhost:5432/agent_hq?sslmode=disable&sslmode=require'
      )
    ).toThrow('must not repeat the sslmode parameter')
  })

  test('every accepted hosted URL leaves the driver with TLS on', () => {
    // Guards the validator against drifting from what Postgres.js actually applies.
    for (const mode of ['require', 'verify-ca', 'verify-full']) {
      const url = `postgresql://app:secret@db.example.com:5432/agent_hq?sslmode=${mode}`
      readDatabaseTarget(url)
      expect(driverSsl(url)).not.toBe(false)
    }
    expect(() =>
      readDatabaseTarget(hostedUrl('db.example.com').replace('require', 'disable'))
    ).toThrow('Hosted DATABASE_URL must require TLS')
  })

  test('prepares statements for every hosted origin, including a retired provider endpoint', () => {
    // The retired provider's transaction-pooled endpoint shape is not special any more: no
    // hostname decides the statement mode, so the shape that used to force `prepare: false`
    // prepares statements like every other origin.
    for (const host of [
      'ep-cool-1234-pooler.us-east-2.aws.neon.tech',
      'ep-cool-1234.us-east-2.aws.neon.tech',
      'adea-db.hyperdrive.cloudflare.com',
      'abc123.proxy.rlwy.net',
    ]) {
      const target = readDatabaseTarget(hostedUrl(host))
      expect(target.preparedStatements).toBe(true)
    }
  })
})
