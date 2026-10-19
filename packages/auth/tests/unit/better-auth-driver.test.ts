import { describe, expect, test } from 'bun:test'

import { createAuthAdapter } from '../../src/adapter'
import { createBetterAuthDriver, type BetterAuthServerApi } from '../../src/better-auth-driver'

const providerSession = {
  session: { expiresAt: new Date('2030-01-01T00:00:00.000Z'), id: 'session-1' },
  user: { id: 'provider-subject', name: 'Operator' },
}

function apiFixture(overrides: Partial<BetterAuthServerApi> = {}): BetterAuthServerApi {
  return {
    getSession: async () => ({ data: providerSession, error: null }),
    listSessions: async () => ({
      data: [{ id: 'session-1', token: 'fixture-token' }],
      error: null,
    }),
    revokeSession: async () => ({ data: true, error: null }),
    signInEmail: async () => ({ data: providerSession, error: null }),
    signOut: async () => ({ data: true, error: null }),
    signUpEmail: async () => ({ data: providerSession, error: null }),
    ...overrides,
  }
}

describe('Better Auth server driver', () => {
  test('creates an email account and returns the provider-neutral session', async () => {
    let createdAccount: unknown
    const api = apiFixture({
      signUpEmail: async (registration) => {
        createdAccount = registration
        return { data: providerSession, error: null }
      },
    })

    const adapter = createAuthAdapter(createBetterAuthDriver(api), { provider: 'better-auth' })
    const session = await adapter.signUp({
      email: 'operator@example.test',
      name: 'Operator',
      password: 'correct horse battery staple',
    })

    expect(createdAccount).toEqual({
      email: 'operator@example.test',
      name: 'Operator',
      password: 'correct horse battery staple',
    })
    expect(session.identity).toEqual({ provider: 'better-auth', subject: 'provider-subject' })
  })

  test('bypasses the session cookie cache during refresh', async () => {
    const calls: unknown[] = []
    const api = apiFixture({
      getSession: async (options) => {
        calls.push(options)
        return { data: providerSession, error: null }
      },
    })

    const adapter = createAuthAdapter(createBetterAuthDriver(api), { provider: 'better-auth' })
    expect(await adapter.refreshSession()).not.toBeNull()
    expect(calls).toEqual([{ disableCookieCache: true }])
  })

  test('maps an internal session ID to a provider token only inside the driver', async () => {
    let revokedToken: string | undefined
    const api = apiFixture({
      revokeSession: async ({ token }) => {
        revokedToken = token
        return { data: true, error: null }
      },
    })

    const adapter = createAuthAdapter(createBetterAuthDriver(api), { provider: 'better-auth' })
    await adapter.revokeSession('session-1')
    expect(revokedToken).toBe('fixture-token')
    expect(Object.keys(adapter)).not.toContain('token')
  })

  test('preserves the provider error code without leaking provider prose', async () => {
    const api = apiFixture({
      signInEmail: async () => ({
        data: null,
        error: {
          body: { code: 'INVALID_EMAIL_OR_PASSWORD' },
          message: 'raw operator@example.test',
        },
      }),
    })
    const driver = createBetterAuthDriver(api)
    await expect(
      driver.signIn({ email: 'operator@example.test', password: 'wrong' })
    ).rejects.toMatchObject({
      code: 'invalid_email_or_password',
      message: 'Authentication provider request failed',
    })
  })

  test('fails closed without fetching a session when authentication is denied', async () => {
    let lookups = 0
    const api = apiFixture({
      getSession: async () => {
        lookups += 1
        return { data: providerSession, error: null }
      },
      signInEmail: async () => ({ data: null, error: { code: 'invalid_credentials' } }),
      signUpEmail: async () => ({ data: null, error: null }),
    })
    const driver = createBetterAuthDriver(api)

    await expect(
      driver.signIn({ email: 'operator@example.test', password: 'wrong' })
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
    await expect(
      driver.signUp({ email: 'operator@example.test', name: 'Operator', password: 'wrong' })
    ).rejects.toMatchObject({ message: 'Authentication provider request failed' })
    expect(lookups).toBe(0)
  })

  test('keeps an anonymous lookup null but refuses a missing session during refresh', async () => {
    const driver = createBetterAuthDriver(
      apiFixture({ getSession: async () => ({ data: null, error: null }) })
    )
    expect(await driver.getSession()).toBeNull()
    await expect(driver.refreshSession()).rejects.toMatchObject({
      message: 'Authentication provider request failed',
    })
  })

  test('never revokes a different session when the requested id is absent or listing fails', async () => {
    let revoked = 0
    const api = apiFixture({
      revokeSession: async () => {
        revoked += 1
        return { data: true, error: null }
      },
    })
    await expect(createBetterAuthDriver(api).revokeSession('absent')).rejects.toThrow(
      'Authentication session is unavailable'
    )

    const failing = apiFixture({
      listSessions: async () => ({ data: null, error: { code: 'internal_error' } }),
      revokeSession: async () => {
        revoked += 1
        return { data: true, error: null }
      },
    })
    await expect(createBetterAuthDriver(failing).revokeSession('session-1')).rejects.toMatchObject({
      code: 'internal_error',
    })
    expect(revoked).toBe(0)
  })

  test('surfaces a sign-out failure through a sanitized error', async () => {
    let signedOut = 0
    const api = apiFixture({
      signOut: async () => {
        signedOut += 1
        return { data: null, error: { message: 'private logout detail' } }
      },
    })
    await expect(createBetterAuthDriver(api).signOut()).rejects.toMatchObject({
      message: 'Authentication provider request failed',
    })
    expect(signedOut).toBe(1)
  })

  test('an expired provider session is normalized away (fail closed)', async () => {
    const api = apiFixture({
      getSession: async () => ({
        data: {
          session: { expiresAt: new Date('2020-01-01T00:00:00.000Z'), id: 'expired' },
          user: { id: 'provider-subject' },
        },
        error: null,
      }),
    })
    const adapter = createAuthAdapter(createBetterAuthDriver(api), { provider: 'better-auth' })
    expect(await adapter.getSession()).toBeNull()
  })
})
