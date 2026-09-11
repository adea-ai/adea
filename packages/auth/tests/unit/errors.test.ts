import { describe, expect, test } from 'bun:test'

import { createAuthAdapter } from '../../src/adapter'
import { AUTH_ERROR_CODES, AuthProviderError, authErrorCode, providerError } from '../../src/errors'
import { createNeonAuthDriver, type NeonSdk } from '../../src/neon-driver'

describe('provider error codes', () => {
  test('reads a normalized code from the SDK error', () => {
    expect(authErrorCode({ code: 'INVALID_EMAIL_OR_PASSWORD' })).toBe('invalid_email_or_password')
    expect(authErrorCode({ code: 'invalid_credentials' })).toBe('invalid_credentials')
    expect(authErrorCode({ code: 'USER-ALREADY-EXISTS' })).toBe('user_already_exists')
  })

  test('falls back to a nested body code and then a cause', () => {
    expect(authErrorCode({ body: { code: 'weak_password' } })).toBe('weak_password')
    expect(authErrorCode({ cause: { code: 'over_request_rate_limit' } })).toBe(
      'over_request_rate_limit'
    )
  })

  test('returns null for absent or unusable codes', () => {
    for (const value of [null, undefined, 'string-error', 42, {}, { code: '' }, { code: 7 }]) {
      expect(authErrorCode(value)).toBeNull()
    }
  })

  test('drops provider prose so submitted addresses cannot leak into UI or logs', () => {
    const error = providerError({
      code: 'invalid_credentials',
      message: 'Invalid email or password for person@example.test',
    })
    expect(error).toBeInstanceOf(AuthProviderError)
    expect(error.code).toBe('invalid_credentials')
    expect(error.message).toBe('Authentication provider request failed')
    expect(error.message).not.toContain('person@example.test')
    expect(error.isCredentialRejection).toBe(true)
  })

  test('treats non-credential failures as retryable rather than user error', () => {
    for (const code of [
      null,
      AUTH_ERROR_CODES.overRequestRateLimit,
      AUTH_ERROR_CODES.sessionExpired,
      AUTH_ERROR_CODES.validationFailed,
    ]) {
      expect(providerError({ code }).isCredentialRejection).toBe(false)
    }
    for (const code of [
      AUTH_ERROR_CODES.invalidCredentials,
      AUTH_ERROR_CODES.emailNotConfirmed,
      AUTH_ERROR_CODES.userAlreadyExists,
      AUTH_ERROR_CODES.emailExists,
    ]) {
      expect(providerError({ code }).isCredentialRejection).toBe(true)
    }
  })
})

describe('driver failures keep their cause', () => {
  const sdk = (overrides: Partial<NeonSdk>): NeonSdk =>
    ({
      getSession: async () => ({ data: null, error: null }),
      listSessions: async () => ({ data: [], error: null }),
      refreshToken: async () => ({ data: null, error: null }),
      revokeSession: async () => ({ data: null, error: null }),
      signIn: { email: async () => ({ data: null, error: null }) },
      signUp: { email: async () => ({ data: null, error: null }) },
      signOut: async () => ({ data: null, error: null }),
      ...overrides,
    }) as NeonSdk

  test('a rejected sign-in reports invalid_credentials, not a generic failure', async () => {
    const driver = createNeonAuthDriver(
      sdk({
        signIn: {
          email: async () => ({
            data: null,
            error: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
          }),
        },
      })
    )
    await expect(
      driver.signIn({ email: 'person@example.test', password: 'wrong' })
    ).rejects.toThrow(AuthProviderError)
    try {
      await driver.signIn({ email: 'person@example.test', password: 'wrong' })
    } catch (error) {
      expect(authErrorCode(error)).toBe('invalid_email_or_password')
    }
  })

  test('an existing account on sign-up reports user_already_exists', async () => {
    const driver = createNeonAuthDriver(
      sdk({
        signUp: {
          email: async () => ({ data: null, error: { code: 'USER_ALREADY_EXISTS' } }),
        },
      })
    )
    try {
      await driver.signUp({
        email: 'person@example.test',
        password: 'long-enough-password',
        name: 'P',
      })
      throw new Error('expected sign-up to fail')
    } catch (error) {
      expect(authErrorCode(error)).toBe('user_already_exists')
      expect((error as AuthProviderError).isCredentialRejection).toBe(true)
    }
  })

  test('an unconfirmed email is distinguishable from a wrong password', async () => {
    const driver = createNeonAuthDriver(
      sdk({
        signIn: { email: async () => ({ data: null, error: { code: 'EMAIL_NOT_CONFIRMED' } }) },
      })
    )
    try {
      await driver.signIn({ email: 'person@example.test', password: 'correct' })
      throw new Error('expected sign-in to fail')
    } catch (error) {
      expect(authErrorCode(error)).toBe('email_not_confirmed')
    }
  })

  test('a provider outage stays a transport failure, not a credential rejection', async () => {
    const driver = createNeonAuthDriver(
      sdk({ getSession: async () => ({ data: null, error: new Error('socket hang up') }) })
    )
    try {
      await driver.getSession()
      throw new Error('expected getSession to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(AuthProviderError)
      expect((error as AuthProviderError).isCredentialRejection).toBe(false)
    }
  })

  test('the adapter still normalizes a successful session', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const driver = createNeonAuthDriver(
      sdk({
        getSession: async () => ({
          data: {
            session: { expiresAt, id: 'session-1' },
            user: { email: 'p@example.test', id: 'user-1' },
          },
          error: null,
        }),
      })
    )
    const adapter = createAuthAdapter(driver)
    const session = await adapter.getSession()
    expect(session?.identity.subject).toBe('user-1')
    expect(session?.profile.email).toBe('p@example.test')
  })
})
