import { describe, expect, test } from 'bun:test'
import { Client } from 'pg'

import { readBetterAuthConfig } from '../../src/config'

const base = {
  AUTH_BASE_URL: 'https://auth.adea.dev',
  AUTH_DATABASE_URL: 'postgres://adea:secret@railway.internal:5432/adea?sslmode=require',
  AUTH_SECRET: 'a-secure-better-auth-secret-that-is-long-enough',
  AUTH_TRUSTED_ORIGINS: 'https://adea.dev,adea://auth/callback',
}

// `pg` parses the connection string in the Client constructor (through the
// pinned pg-connection-string), so the resolved host/ssl are exactly the
// parameters the pool would connect with — read without opening a socket.
function pgTarget(url: string): { host?: string; ssl: boolean } {
  const client = new Client({ connectionString: url })
  const parameters = (
    client as unknown as { connectionParameters: { host?: string; ssl?: unknown } }
  ).connectionParameters
  return { host: parameters.host, ssl: Boolean(parameters.ssl) }
}

describe('Better Auth configuration', () => {
  test('reads a fresh Railway deployment with secure defaults', () => {
    const config = readBetterAuthConfig(base)
    expect(config.baseUrl).toBe('https://auth.adea.dev')
    expect(config.secureCookies).toBe(true)
    // Mailbox proof is on by default: email-based authority needs a verified address.
    expect(config.emailVerificationRequired).toBe(true)
    expect(config.databaseRequiresTls).toBe(true)
    expect(config.sessionExpiresInSeconds).toBe(60 * 60 * 24 * 7)
    expect(config.sessionUpdateAgeSeconds).toBe(60 * 60 * 24)
    expect(config.trustedOrigins).toEqual(['https://adea.dev', 'adea://auth/callback'])
    expect(config.google).toBeUndefined()
  })

  test('requires HTTPS, a strong secret, and a postgres connection string', () => {
    expect(() => readBetterAuthConfig({ ...base, AUTH_BASE_URL: 'http://remote.test' })).toThrow(
      'HTTPS'
    )
    expect(() => readBetterAuthConfig({ ...base, AUTH_SECRET: 'too-short' })).toThrow('32')
    expect(() => readBetterAuthConfig({ ...base, AUTH_DATABASE_URL: 'mysql://host/db' })).toThrow(
      'postgres'
    )
  })

  test('requires TLS for a hosted database and permits loopback without it', () => {
    expect(() =>
      readBetterAuthConfig({
        ...base,
        AUTH_DATABASE_URL: 'postgres://adea:secret@db.railway.app:5432/adea',
      })
    ).toThrow('TLS')

    const verifyFull = readBetterAuthConfig({
      ...base,
      AUTH_DATABASE_URL: 'postgres://adea:secret@db.railway.app:5432/adea?sslmode=verify-full',
    })
    expect(verifyFull.databaseRequiresTls).toBe(true)

    const loopback = readBetterAuthConfig({
      ...base,
      AUTH_DATABASE_URL: 'postgres://adea@localhost:5432/adea',
    })
    expect(loopback.databaseRequiresTls).toBe(false)
  })

  test('resolves conflicting sslmode/ssl options the way the pg client does', () => {
    const requireThenDisable =
      'postgres://adea:secret@db.railway.app:5432/adea?sslmode=require&sslmode=disable'
    expect(pgTarget(requireThenDisable)).toEqual({ host: 'db.railway.app', ssl: false })
    expect(() => readBetterAuthConfig({ ...base, AUTH_DATABASE_URL: requireThenDisable })).toThrow(
      'TLS'
    )

    const disableThenSsl =
      'postgres://adea:secret@db.railway.app:5432/adea?sslmode=disable&ssl=true'
    expect(pgTarget(disableThenSsl)).toEqual({ host: 'db.railway.app', ssl: false })
    expect(() => readBetterAuthConfig({ ...base, AUTH_DATABASE_URL: disableThenSsl })).toThrow(
      'TLS'
    )

    const verifyFullThenDisable =
      'postgres://adea:secret@db.railway.app:5432/adea?sslmode=verify-full&sslmode=disable'
    expect(pgTarget(verifyFullThenDisable).ssl).toBe(false)
    expect(() =>
      readBetterAuthConfig({ ...base, AUTH_DATABASE_URL: verifyFullThenDisable })
    ).toThrow('TLS')
  })

  test('validates the effective host a query override names, not the URL authority', () => {
    const override = 'postgres://adea@localhost:5432/adea?host=db.railway.app'
    expect(pgTarget(override).host).toBe('db.railway.app')
    expect(() => readBetterAuthConfig({ ...base, AUTH_DATABASE_URL: override })).toThrow('TLS')

    const overrideWithTls =
      'postgres://adea@localhost:5432/adea?host=db.railway.app&sslmode=require'
    expect(pgTarget(overrideWithTls).host).toBe('db.railway.app')
    expect(
      readBetterAuthConfig({ ...base, AUTH_DATABASE_URL: overrideWithTls }).databaseRequiresTls
    ).toBe(true)

    const loopbackOverride = 'postgres://adea@localhost:5432/adea?host=127.0.0.1'
    expect(pgTarget(loopbackOverride).host).toBe('127.0.0.1')
    expect(
      readBetterAuthConfig({ ...base, AUTH_DATABASE_URL: loopbackOverride }).databaseRequiresTls
    ).toBe(false)
  })

  test('accepts loopback HTTP and downgrades cookies only there', () => {
    const config = readBetterAuthConfig({
      ...base,
      AUTH_BASE_URL: 'http://127.0.0.1:8787',
      AUTH_DATABASE_URL: 'postgres://adea@localhost:5432/adea',
      AUTH_SECURE_COOKIES: 'false',
      AUTH_TRUSTED_ORIGINS: 'http://localhost:3000,adea://auth/callback',
    })
    expect(config.secureCookies).toBe(false)
    expect(config.trustedOrigins).toEqual(['http://localhost:3000', 'adea://auth/callback'])
  })

  test('refuses to disable secure cookies on a hosted base URL', () => {
    expect(() => readBetterAuthConfig({ ...base, AUTH_SECURE_COOKIES: 'false' })).toThrow(
      'AUTH_SECURE_COOKIES'
    )
  })

  test('rejects wildcards and credential-bearing origins', () => {
    expect(() =>
      readBetterAuthConfig({ ...base, AUTH_TRUSTED_ORIGINS: 'https://*.adea.dev' })
    ).toThrow('wildcard')
    expect(() =>
      readBetterAuthConfig({ ...base, AUTH_TRUSTED_ORIGINS: 'https://user:secret@adea.dev' })
    ).toThrow('credentials')
  })

  test('requires the Google client pair together and keeps configured values', () => {
    expect(() => readBetterAuthConfig({ ...base, GOOGLE_CLIENT_ID: 'only-id' })).toThrow('together')
    const config = readBetterAuthConfig({
      ...base,
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    })
    expect(config.google).toEqual({ clientId: 'client-id', clientSecret: 'client-secret' })
  })

  test('honors explicit session and verification overrides', () => {
    const config = readBetterAuthConfig({
      ...base,
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'false',
      AUTH_SESSION_EXPIRES_IN_SECONDS: '3600',
      AUTH_SESSION_UPDATE_AGE_SECONDS: '60',
    })
    expect(config.emailVerificationRequired).toBe(false)
    expect(config.secureCookies).toBe(true)
    expect(config.sessionExpiresInSeconds).toBe(3600)
    expect(config.sessionUpdateAgeSeconds).toBe(60)
  })

  test('rejects malformed numeric overrides', () => {
    expect(() => readBetterAuthConfig({ ...base, AUTH_SESSION_EXPIRES_IN_SECONDS: '0' })).toThrow(
      'positive'
    )
    expect(() => readBetterAuthConfig({ ...base, AUTH_SECURE_COOKIES: 'maybe' })).toThrow(
      'true or false'
    )
  })
})
