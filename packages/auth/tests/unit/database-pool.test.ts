import { expect, test } from 'bun:test'
import { Client } from 'pg'
import { authDatabasePoolOptions } from '../../src/database-pool'

const runtime =
  'postgresql://adea_prod_auth_app:synthetic@altaria.proxy.rlwy.net:44407/railway?sslmode=verify-full'
test('the effective auth driver verifies the reviewed public endpoint with its authenticated CA', () => {
  const options = authDatabasePoolOptions(runtime)
  const parameters = (
    new Client(options) as unknown as {
      connectionParameters: { host: string; ssl: { ca: string; rejectUnauthorized: boolean } }
    }
  ).connectionParameters
  expect(parameters.host).toBe('altaria.proxy.rlwy.net')
  expect(parameters.ssl.rejectUnauthorized).toBe(true)
  expect(parameters.ssl.ca).toContain('-----BEGIN CERTIFICATE-----')
})
test('auth migrations use the dedicated role and exactly one auth schema', () => {
  const options = authDatabasePoolOptions(
    runtime.replace('adea_prod_auth_app', 'adea_prod_migration'),
    'migration'
  )
  expect(options.options).toBe('-c search_path=auth')
  expect(() => authDatabasePoolOptions(runtime, 'migration')).toThrow()
  expect(() => authDatabasePoolOptions(runtime.replace('adea_prod_auth_app', 'postgres'))).toThrow()
})
test('auth origin overrides and weaker TLS are refused', () => {
  for (const change of [
    (u) => {
      u.searchParams.set('host', 'evil.invalid')
    },
    (u) => {
      u.searchParams.set('sslmode', 'require')
    },
    (u) => {
      u.pathname = '/other'
    },
    (u) => {
      u.port = '5432'
    },
  ]) {
    const url = new URL(runtime)
    change(url)
    expect(() => authDatabasePoolOptions(url.href)).toThrow()
  }
})
test('disposable local auth databases remain independent of production', () => {
  const url = 'postgresql://fixture:synthetic@127.0.0.1:15432/fixture'
  expect(authDatabasePoolOptions(url)).toEqual({ connectionString: url })
})
