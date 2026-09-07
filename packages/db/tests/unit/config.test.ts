import { describe, expect, test } from 'bun:test'

import { readDatabaseUrl } from '../../src/config'

describe('database configuration', () => {
  test('requires a server-side PostgreSQL URL', () => {
    expect(() => readDatabaseUrl({})).toThrow('DATABASE_URL is required')
    expect(() => readDatabaseUrl({ DATABASE_URL: 'https://example.com' })).toThrow('PostgreSQL')
  })

  test('rejects client-prefixed database credentials', () => {
    expect(() =>
      readDatabaseUrl({
        DATABASE_URL: 'postgresql://app:secret@localhost:5432/agent_hq',
        NEXT_PUBLIC_DATABASE_URL: 'postgresql://leaked:secret@localhost/db',
      })
    ).toThrow('client-exposed')
  })
})
