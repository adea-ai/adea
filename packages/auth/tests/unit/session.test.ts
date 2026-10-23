import { describe, expect, test } from 'bun:test'

import { normalizeProviderSession } from '../../src/session'

describe('session normalization', () => {
  test('keeps provider identity distinct from a domain user ID', () => {
    const result = normalizeProviderSession(
      {
        session: { expiresAt: new Date('2030-01-01T00:00:00.000Z'), id: 'session-1' },
        user: {
          id: 'provider-subject',
          email: 'operator@example.com',
          emailVerified: true,
          name: 'Operator',
        },
      },
      { now: new Date('2029-01-01T00:00:00.000Z') }
    )

    expect(result).toEqual({
      identity: { provider: 'better-auth', subject: 'provider-subject' },
      session: { expiresAt: '2030-01-01T00:00:00.000Z', id: 'session-1' },
      profile: { displayName: 'Operator', email: 'operator@example.com' },
    })
    expect(result).not.toHaveProperty('userId')
  })

  test('withholds the email until the mailbox is verified', () => {
    const result = normalizeProviderSession(
      {
        session: { expiresAt: new Date('2030-01-01T00:00:00.000Z'), id: 'session-1' },
        user: {
          id: 'provider-subject',
          email: 'unverified@example.com',
          emailVerified: false,
          name: 'Operator',
        },
      },
      { now: new Date('2029-01-01T00:00:00.000Z') }
    )

    // Email-based authority (allowlists, invitations) must not see an unproven
    // address, but the identity and display name survive.
    expect(result?.profile).toEqual({ displayName: 'Operator' })
    expect(result?.identity.subject).toBe('provider-subject')
  })

  test('fails closed for missing, expired, or malformed sessions', () => {
    expect(normalizeProviderSession(null)).toBeNull()
    expect(() =>
      normalizeProviderSession({
        session: { expiresAt: new Date('2020-01-01T00:00:00.000Z'), id: 'expired' },
        user: { id: 'provider-subject' },
      })
    ).toThrow('expired')
    expect(() => normalizeProviderSession({ session: {}, user: {} })).toThrow('malformed')
  })
})
