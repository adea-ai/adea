import { describe, expect, test } from 'bun:test'
import { authDatabaseConnectionForRequest } from '../src/server/auth-database'

describe('auth database transport', () => {
  const hosted = {
    AUTH_DATABASE_URL: 'postgresql://auth:fixture@db.example/railway?sslmode=verify-full',
  }
  test('selects auth pool independently of the application pool on every request', () => {
    const bindings = {
      HYPERDRIVE: { connectionString: 'postgresql://app/pool' },
      AUTH_HYPERDRIVE: { connectionString: 'postgresql://auth/pool-one' },
    }
    expect(authDatabaseConnectionForRequest(bindings, hosted)).toBe('postgresql://auth/pool-one')
    bindings.AUTH_HYPERDRIVE.connectionString = 'postgresql://auth/pool-two'
    expect(authDatabaseConnectionForRequest(bindings, hosted)).toBe('postgresql://auth/pool-two')
  })
  test('refuses hosted Worker direct connections without exposing their URL', () => {
    expect(() => authDatabaseConnectionForRequest({}, hosted)).toThrow(
      'Hosted Worker auth requires its dedicated Hyperdrive binding'
    )
    expect(() =>
      authDatabaseConnectionForRequest({ AUTH_HYPERDRIVE: { connectionString: '' } }, hosted)
    ).toThrow('Hosted Worker auth requires its dedicated Hyperdrive binding')
    expect(() =>
      authDatabaseConnectionForRequest({}, { AUTH_DATABASE_URL: 'invalid-secret' })
    ).toThrow('Hosted Worker auth requires its dedicated Hyperdrive binding')
  })
  test('retains direct loopback qualification and non-Worker operation', () => {
    expect(
      authDatabaseConnectionForRequest(
        {},
        { AUTH_DATABASE_URL: 'postgresql://fixture@127.0.0.1/auth' }
      )
    ).toBeUndefined()
    expect(authDatabaseConnectionForRequest(undefined, hosted)).toBeUndefined()
    expect(authDatabaseConnectionForRequest({}, {})).toBeUndefined()
  })
})
