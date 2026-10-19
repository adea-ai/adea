import { afterEach, describe, expect, test } from 'bun:test'

import {
  resolveDatabaseConnection,
  resolveDatabaseConnectionString,
  shouldRegisterDatabaseShutdownHooks,
} from '../src/server/database-connection'
import { captureWorkerBindings } from '../src/server/worker-bindings'

const VALID_URL = 'postgresql://app:secret@db.example.com:5432/agent_hq?sslmode=require'

afterEach(() => {
  // Leave no captured binding behind for the next test file on this worker.
  captureWorkerBindings(undefined)
})

describe('database connection resolution', () => {
  test('returns DATABASE_URL when no Hyperdrive binding is present', () => {
    expect(resolveDatabaseConnectionString({ DATABASE_URL: VALID_URL })).toBe(VALID_URL)
    expect(resolveDatabaseConnection({ DATABASE_URL: VALID_URL }).source).toBe('direct')
  })

  test('prefers the Hyperdrive binding and reports the pooled source', () => {
    const hyperdrive = 'postgresql://app:secret@db.hyperdrive.cloudflare.com:5432/agent_hq'
    captureWorkerBindings({ HYPERDRIVE: { connectionString: hyperdrive } })
    expect(resolveDatabaseConnection({ DATABASE_URL: VALID_URL })).toEqual({
      connectionString: hyperdrive,
      source: 'hyperdrive',
    })
  })

  test('ignores an empty Hyperdrive binding and falls back to DATABASE_URL', () => {
    captureWorkerBindings({ HYPERDRIVE: {} })
    expect(resolveDatabaseConnection({ DATABASE_URL: VALID_URL }).source).toBe('direct')
  })

  test('requires DATABASE_URL when no Hyperdrive binding is present', () => {
    expect(() => resolveDatabaseConnectionString({})).toThrow('DATABASE_URL is required')
  })

  test('rejects client-exposed database keys', () => {
    expect(() =>
      resolveDatabaseConnectionString({
        DATABASE_URL: VALID_URL,
        NEXT_PUBLIC_DATABASE_URL: VALID_URL,
      })
    ).toThrow('must never be client-exposed')
  })

  test('applies strict TLS to a direct hosted URL', () => {
    expect(() =>
      resolveDatabaseConnectionString({
        DATABASE_URL: 'postgresql://app:secret@db.example.com:5432/agent_hq',
      })
    ).toThrow('Hosted DATABASE_URL must require TLS')
  })

  test('registers shutdown hooks outside the Workers runtime', () => {
    expect(shouldRegisterDatabaseShutdownHooks()).toBe(true)
  })
})
