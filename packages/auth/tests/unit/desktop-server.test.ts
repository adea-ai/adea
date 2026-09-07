import { describe, expect, test } from 'bun:test'

import { createDesktopAuthorizationAttempt } from '../../src/desktop'
import {
  createDesktopAuthorizationCodeBroker,
  createDesktopSessionService,
  type DesktopAuthorizationCodeRecord,
  type DesktopAuthorizationCodeStore,
  type DesktopSessionRecord,
  type DesktopSessionStore,
} from '../../src/desktop-server'

function memoryStore(): DesktopAuthorizationCodeStore {
  const records = new Map<string, DesktopAuthorizationCodeRecord>()
  return {
    async consume(codeDigest) {
      const record = records.get(codeDigest) ?? null
      records.delete(codeDigest)
      return record
    },
    async save(record) {
      records.set(record.codeDigest, record)
    },
  }
}

function memorySessionStore(): DesktopSessionStore {
  const records = new Map<string, DesktopSessionRecord>()
  return {
    async create(record) {
      records.set(record.credentialDigest, record)
    },
    async revoke({ credentialDigest, sessionId }) {
      const record = records.get(credentialDigest)
      if (!record || record.sessionId !== sessionId || record.revokedAt) return false
      records.set(credentialDigest, { ...record, revokedAt: Date.now() })
      return true
    },
    async resolve({ credentialDigest, now, sessionId }) {
      const record = records.get(credentialDigest)
      if (
        !record ||
        record.sessionId !== sessionId ||
        record.revokedAt ||
        record.expiresAt <= now
      ) {
        return null
      }
      return record
    },
    async rotate({ credentialDigest, expiresAt, nextCredentialDigest, now, sessionId }) {
      const record = records.get(credentialDigest)
      if (
        !record ||
        record.sessionId !== sessionId ||
        record.revokedAt ||
        record.expiresAt <= now
      ) {
        return null
      }
      records.delete(credentialDigest)
      const rotated = { ...record, credentialDigest: nextCredentialDigest, expiresAt }
      records.set(nextCredentialDigest, rotated)
      return rotated
    },
  }
}

describe('desktop server-side code exchange', () => {
  test('exchanges a short-lived code with its PKCE verifier exactly once', async () => {
    const attempt = await createDesktopAuthorizationAttempt({ now: 1_000 })
    const broker = createDesktopAuthorizationCodeBroker({
      issueSession: async (providerSessionId) => ({
        credential: `desktop:${providerSessionId.providerSessionId}`,
        expiresAt: '2030-01-01T00:00:00.000Z',
        sessionId: 'desktop-session-1',
      }),
      now: () => 1_001,
      store: memoryStore(),
    })
    const callback = await broker.issue({
      codeChallenge: attempt.codeChallenge,
      nonce: attempt.nonce,
      providerExpiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
      providerSessionId: 'provider-session-1',
      redirectUri: attempt.redirectUri,
      state: attempt.state,
      userId: 'user-1',
    })
    const callbackUrl = new URL(callback)
    const input = {
      code: callbackUrl.searchParams.get('code')!,
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
      redirectUri: attempt.redirectUri,
    }

    expect(callback).not.toContain('provider-session-1')
    expect(callback).not.toMatch(/access_token|refresh_token|session_token/i)
    await expect(broker.exchange(input)).resolves.toMatchObject({
      credential: 'desktop:provider-session-1',
    })
    await expect(broker.exchange(input)).rejects.toThrow('unavailable')
  })

  test('rejects an invalid verifier and an expired one-time code', async () => {
    const verifierAttempt = await createDesktopAuthorizationAttempt({ now: 1_000 })
    const verifierBroker = createDesktopAuthorizationCodeBroker({
      issueSession: async () => {
        throw new Error('must not issue')
      },
      now: () => 1_001,
      store: memoryStore(),
    })
    const verifierCallback = new URL(
      await verifierBroker.issue({
        codeChallenge: verifierAttempt.codeChallenge,
        nonce: verifierAttempt.nonce,
        providerExpiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
        providerSessionId: 'provider-session-1',
        redirectUri: verifierAttempt.redirectUri,
        state: verifierAttempt.state,
        userId: 'user-1',
      })
    )
    await expect(
      verifierBroker.exchange({
        code: verifierCallback.searchParams.get('code')!,
        codeVerifier: 'x'.repeat(64),
        nonce: verifierAttempt.nonce,
        redirectUri: verifierAttempt.redirectUri,
      })
    ).rejects.toThrow('PKCE verifier mismatch')

    const expiredAttempt = await createDesktopAuthorizationAttempt({ now: 1_000 })
    let now = 1_000
    const expiredBroker = createDesktopAuthorizationCodeBroker({
      issueSession: async () => {
        throw new Error('must not issue')
      },
      now: () => now,
      store: memoryStore(),
      ttlMs: 5,
    })
    const expiredCallback = new URL(
      await expiredBroker.issue({
        codeChallenge: expiredAttempt.codeChallenge,
        nonce: expiredAttempt.nonce,
        providerExpiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
        providerSessionId: 'provider-session-1',
        redirectUri: expiredAttempt.redirectUri,
        state: expiredAttempt.state,
        userId: 'user-1',
      })
    )
    now = 1_006
    await expect(
      expiredBroker.exchange({
        code: expiredCallback.searchParams.get('code')!,
        codeVerifier: expiredAttempt.codeVerifier,
        nonce: expiredAttempt.nonce,
        redirectUri: expiredAttempt.redirectUri,
      })
    ).rejects.toThrow('expired')
  })
})

describe('desktop application sessions', () => {
  test('issues an opaque credential and rotates it on refresh', async () => {
    let now = Date.parse('2026-08-24T12:00:00.000Z')
    const service = createDesktopSessionService({
      now: () => now,
      store: memorySessionStore(),
    })
    const session = await service.issue({
      providerExpiresAt: now + 3_600_000,
      providerSessionId: 'provider-session-1',
      userId: 'user-1',
    })

    expect(session.credential).not.toContain('provider-session-1')
    expect(session.credential).not.toContain('user-1')
    await expect(service.resolve(session)).resolves.toEqual({
      providerExpiresAt: now + 3_600_000,
      providerSessionId: 'provider-session-1',
      userId: 'user-1',
    })
    now += 1_000
    const refreshed = await service.refresh(session)
    expect(refreshed.sessionId).toBe(session.sessionId)
    expect(refreshed.credential).not.toBe(session.credential)
    await expect(service.resolve(session)).resolves.toBeNull()
    await expect(service.resolve(refreshed)).resolves.toMatchObject({ userId: 'user-1' })
    await expect(service.refresh(session)).rejects.toThrow('unavailable')
  })

  test('keeps a granted desktop session beyond the browser provider session', async () => {
    let now = Date.parse('2026-08-24T12:00:00.000Z')
    const service = createDesktopSessionService({
      now: () => now,
      store: memorySessionStore(),
    })
    const session = await service.issue({
      providerExpiresAt: now + 3_600_000,
      providerSessionId: 'provider-session-1',
      userId: 'user-1',
    })

    expect(Date.parse(session.expiresAt) - now).toBe(30 * 24 * 60 * 60 * 1_000)
    now += 2 * 3_600_000
    await expect(service.resolve(session)).resolves.toMatchObject({ userId: 'user-1' })

    const refreshed = await service.refresh(session)
    expect(Date.parse(refreshed.expiresAt) - now).toBe(30 * 24 * 60 * 60 * 1_000)
  })

  test('revocation invalidates the user session without accepting replay', async () => {
    const now = Date.parse('2026-08-24T12:00:00.000Z')
    const service = createDesktopSessionService({ now: () => now, store: memorySessionStore() })
    const session = await service.issue({
      providerExpiresAt: now + 3_600_000,
      providerSessionId: 'provider-session-1',
      userId: 'user-1',
    })

    await service.revoke(session)
    await expect(service.resolve(session)).resolves.toBeNull()
    await expect(service.refresh(session)).rejects.toThrow('unavailable')
    await expect(service.revoke(session)).rejects.toThrow('unavailable')
  })

  test('fails closed when the provider session has expired', async () => {
    const now = Date.parse('2026-08-24T12:00:00.000Z')
    const service = createDesktopSessionService({ now: () => now, store: memorySessionStore() })
    await expect(
      service.issue({
        providerExpiresAt: now,
        providerSessionId: 'provider-session-1',
        userId: 'user-1',
      })
    ).rejects.toThrow('expired')
  })
})
