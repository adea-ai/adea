import { describe, expect, test } from 'bun:test'

import { createAuthAdapter } from '../../src/adapter'
import { createNeonAuthDriver, type NeonSdk } from '../../src/neon-driver'

const providerSession = {
  session: { expiresAt: new Date('2030-01-01T00:00:00.000Z'), id: 'session-1' },
  user: { id: 'provider-subject', name: 'Operator' },
}

describe('Neon SDK driver integration', () => {
  test('creates an email account and returns its authenticated browser session', async () => {
    let createdAccount: unknown
    const sdk = {
      async getSession() {
        return { data: providerSession, error: null }
      },
      signUp: {
        async email(account: unknown) {
          createdAccount = account
          return { data: { user: providerSession.user }, error: null }
        },
      },
    } as unknown as NeonSdk

    const adapter = createAuthAdapter(createNeonAuthDriver(sdk))
    const session = await adapter.signUp({
      email: 'operator@example.com',
      name: 'Operator',
      password: 'correct horse battery staple',
    })

    expect(createdAccount).toEqual({
      email: 'operator@example.com',
      name: 'Operator',
      password: 'correct horse battery staple',
    })
    expect(session.identity.subject).toBe('provider-subject')
  })

  test('bypasses the session cookie cache during refresh', async () => {
    const calls: unknown[] = []
    const sdk = {
      async getSession(options?: unknown) {
        calls.push(options)
        return { data: providerSession, error: null }
      },
    } as unknown as NeonSdk

    const adapter = createAuthAdapter(createNeonAuthDriver(sdk))
    expect(await adapter.refreshSession()).not.toBeNull()
    expect(calls).toEqual([{ query: { disableCookieCache: true } }])
  })

  test('maps an internal session ID to a provider token only inside the driver', async () => {
    let revokedToken: string | undefined
    const sdk = {
      async listSessions() {
        return { data: [{ id: 'session-1', token: 'provider-token' }], error: null }
      },
      async revokeSession({ token }: { token: string }) {
        revokedToken = token
        return { data: true, error: null }
      },
    } as unknown as NeonSdk

    const adapter = createAuthAdapter(createNeonAuthDriver(sdk))
    await adapter.revokeSession('session-1')
    expect(revokedToken).toBe('provider-token')
    expect(Object.keys(adapter)).not.toContain('token')
  })

  test('fails closed without leaking provider error details', async () => {
    const sdk = {
      async getSession() {
        return {
          data: null,
          error: { message: 'raw email operator@example.com and secret token' },
        }
      },
    } as unknown as NeonSdk

    const driver = createNeonAuthDriver(sdk)
    await expect(driver.getSession()).rejects.toThrow('Authentication provider request failed')
  })
})

function sdkFixture(overrides: Partial<NeonSdk> = {}): NeonSdk {
  return {
    getSession: async () => ({ data: providerSession, error: null }),
    listSessions: async () => ({
      data: [{ id: 'session-1', token: 'fixture-token' }],
      error: null,
    }),
    refreshToken: async () => ({ data: true, error: null }),
    revokeSession: async () => ({ data: true, error: null }),
    signIn: { email: async () => ({ data: true, error: null }) },
    signUp: { email: async () => ({ data: true, error: null }) },
    signOut: async () => ({ data: true, error: null }),
    ...overrides,
  }
}

describe('fake-backed Neon SDK failure boundaries', () => {
  test('signs in before requesting an uncached authenticated session', async () => {
    const calls: unknown[] = []
    const credentials = { email: 'fixture@example.invalid', password: 'fixture-only' }
    const driver = createNeonAuthDriver(
      sdkFixture({
        signIn: {
          email: async (input) => {
            calls.push(['signIn', input])
            return { data: true, error: null }
          },
        },
        getSession: async (options) => {
          calls.push(['session', options])
          return { data: providerSession, error: null }
        },
      })
    )
    expect(await driver.signIn(credentials)).toBe(providerSession)
    expect(calls).toEqual([
      ['signIn', credentials],
      ['session', { query: { disableCookieCache: true } }],
    ])
  })

  test('does not fetch a fresh session when authentication fails', async () => {
    let lookups = 0
    const sdk = sdkFixture({
      getSession: async () => {
        lookups += 1
        return { data: providerSession, error: null }
      },
      signIn: { email: async () => ({ data: null, error: { message: 'private fake detail' } }) },
      signUp: { email: async () => ({ data: null, error: null }) },
    })
    const driver = createNeonAuthDriver(sdk)
    await expect(
      driver.signIn({ email: 'fixture@example.invalid', password: 'fixture-only' })
    ).rejects.toThrow('Authentication provider request failed')
    await expect(
      driver.signUp({ email: 'fixture@example.invalid', password: 'fixture-only', name: 'Fixture' })
    ).rejects.toThrow('Authentication provider request failed')
    expect(lookups).toBe(0)
  })

  test('keeps anonymous lookup null but refuses a missing session during refresh', async () => {
    const driver = createNeonAuthDriver(
      sdkFixture({ getSession: async () => ({ data: null, error: null }) })
    )
    expect(await driver.getSession()).toBeNull()
    await expect(driver.refreshSession()).rejects.toThrow('Authentication provider request failed')
  })

  test('never revokes a different session when the requested id is absent or listing fails', async () => {
    let revoked = 0
    const sdk = sdkFixture({
      revokeSession: async () => {
        revoked += 1
        return { data: true, error: null }
      },
    })
    await expect(createNeonAuthDriver(sdk).revokeSession('absent')).rejects.toThrow(
      'Authentication session is unavailable'
    )
    sdk.listSessions = async () => ({ data: null, error: { message: 'private list detail' } })
    await expect(createNeonAuthDriver(sdk).revokeSession('session-1')).rejects.toThrow(
      'Authentication provider request failed'
    )
    expect(revoked).toBe(0)
  })

  test('awaits sign-out and surfaces revoke or sign-out failures through sanitized errors', async () => {
    let signedOut = 0
    const sdk = sdkFixture({
      signOut: async () => {
        signedOut += 1
        return { data: true, error: null }
      },
    })
    await createNeonAuthDriver(sdk).signOut()
    expect(signedOut).toBe(1)
    sdk.signOut = async () => ({ data: null, error: { message: 'private logout detail' } })
    sdk.revokeSession = async () => ({ data: null, error: { message: 'private revoke detail' } })
    await expect(createNeonAuthDriver(sdk).signOut()).rejects.toThrow(
      'Authentication provider request failed'
    )
    await expect(createNeonAuthDriver(sdk).revokeSession('session-1')).rejects.toThrow(
      'Authentication provider request failed'
    )
  })
})
