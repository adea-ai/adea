import { describe, expect, test } from 'bun:test'

import { readBetterAuthConfig } from '../../src/config'

const base = {
  AUTH_BASE_URL: 'https://auth.adea.dev',
  AUTH_DATABASE_URL: 'postgres://adea:secret@railway.internal:5432/adea',
  AUTH_SECRET: 'a-secure-better-auth-secret-that-is-long-enough',
  AUTH_TRUSTED_ORIGINS: 'https://adea.dev,adea://auth/callback',
}

describe('Better Auth configuration', () => {
  test('reads a fresh Railway deployment with secure defaults', () => {
    const config = readBetterAuthConfig(base)
    expect(config.baseUrl).toBe('https://auth.adea.dev')
    expect(config.secureCookies).toBe(true)
    expect(config.emailVerificationRequired).toBe(false)
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

  test('accepts loopback HTTP and downgrades cookies only there', () => {
    const config = readBetterAuthConfig({
      ...base,
      AUTH_BASE_URL: 'http://127.0.0.1:8787',
      AUTH_TRUSTED_ORIGINS: 'http://localhost:3000,adea://auth/callback',
    })
    expect(config.secureCookies).toBe(false)
    expect(config.trustedOrigins).toEqual(['http://localhost:3000', 'adea://auth/callback'])
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
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
      AUTH_SECURE_COOKIES: 'false',
      AUTH_SESSION_EXPIRES_IN_SECONDS: '3600',
      AUTH_SESSION_UPDATE_AGE_SECONDS: '60',
    })
    expect(config.emailVerificationRequired).toBe(true)
    expect(config.secureCookies).toBe(false)
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
