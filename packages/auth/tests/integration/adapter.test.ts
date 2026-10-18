import { describe, expect, test } from 'bun:test'

import { createAuthAdapter, type AuthDriver } from '../../src/adapter'

function createDriver(): AuthDriver & { revoked: Set<string> } {
  let activeSession = {
    session: { expiresAt: new Date('2030-01-01T00:00:00.000Z'), id: 'session-before-refresh' },
    user: { id: 'provider-subject', name: 'Operator' },
  }
  const revoked = new Set<string>()

  return {
    revoked,
    async getSession() {
      return revoked.has(activeSession.session.id) ? null : activeSession
    },
    async refreshSession() {
      activeSession = {
        ...activeSession,
        session: { ...activeSession.session, id: 'session-after-refresh' },
      }
      return activeSession
    },
    async signIn() {
      return activeSession
    },
    async signUp() {
      return activeSession
    },
    async signOut() {
      revoked.add(activeSession.session.id)
    },
    async revokeSession(sessionId) {
      revoked.add(sessionId)
    },
  }
}

describe('provider adapter integration', () => {
  test('refreshes a session without changing the provider identity', async () => {
    const adapter = createAuthAdapter(createDriver())
    const before = await adapter.getSession()
    const after = await adapter.refreshSession()

    expect(before?.identity).toEqual(after?.identity)
    expect(after?.session.id).toBe('session-after-refresh')
    expect(adapter).not.toHaveProperty('authorizeWorkspace')
  })

  test('logout and explicit revocation fail closed on later lookup', async () => {
    const driver = createDriver()
    const adapter = createAuthAdapter(driver)

    await adapter.signOut()
    expect(await adapter.getSession()).toBeNull()

    const secondDriver = createDriver()
    const secondAdapter = createAuthAdapter(secondDriver)
    await secondAdapter.revokeSession('session-before-refresh')
    expect(await secondAdapter.getSession()).toBeNull()
  })
})

describe('adapter provider failures and credential flows', () => {
  test('forwards sign-in and registration fields and returns only normalized identity', async () => {
    const driver = createDriver()
    const provider = await driver.getSession()
    if (!provider) throw new Error('Missing fake session')
    const calls: unknown[] = []
    driver.signIn = async (input) => {
      calls.push(input)
      return provider
    }
    driver.signUp = async (input) => {
      calls.push(input)
      return provider
    }
    const adapter = createAuthAdapter(driver)
    const credentials = { email: 'fixture@example.invalid', password: 'fixture-only' }
    const registration = { ...credentials, name: 'Fixture' }
    expect((await adapter.signIn(credentials)).identity).toEqual({
      provider: 'neon',
      subject: 'provider-subject',
    })
    expect((await adapter.signUp(registration)).session.id).toBe('session-before-refresh')
    expect(calls).toEqual([credentials, registration])
  })

  test.each(['getSession', 'refreshSession'] as const)(
    '%s fails closed on provider and normalization errors',
    async (method) => {
      const driver = createDriver()
      const adapter = createAuthAdapter(driver)
      driver[method] = async () => {
        throw new Error('fake provider failure')
      }
      expect(await adapter[method]()).toBeNull()
      driver[method] = async () => ({})
      expect(await adapter[method]()).toBeNull()
      driver[method] = async () => null
      expect(await adapter[method]()).toBeNull()
    }
  )

  test.each(['signIn', 'signUp'] as const)(
    '%s rejects a missing authenticated session',
    async (method) => {
      const driver = createDriver()
      driver[method] = async () => null as never
      const adapter = createAuthAdapter(driver)
      await expect(
        adapter[method]({
          email: 'fixture@example.invalid',
          password: 'fixture-only',
          name: 'Fixture',
        })
      ).rejects.toThrow('Authentication failed')
    }
  )

  test('rejects an empty revoke id before touching its driver and preserves driver failures', async () => {
    const driver = createDriver()
    const calls: string[] = []
    driver.revokeSession = async (id) => {
      calls.push(id)
      throw new Error('fake revoke failed')
    }
    driver.signOut = async () => {
      throw new Error('fake signout failed')
    }
    const adapter = createAuthAdapter(driver)
    await expect(adapter.revokeSession('')).rejects.toThrow('Session ID is required')
    expect(calls).toEqual([])
    await expect(adapter.revokeSession('fixture-session')).rejects.toThrow('fake revoke failed')
    expect(calls).toEqual(['fixture-session'])
    await expect(adapter.signOut()).rejects.toThrow('fake signout failed')
  })
})
