import { describe, expect, test } from 'bun:test'

import {
  createDesktopAuthorizationAttempt,
  createDesktopAuthorizationManager,
  createDesktopAuthorizationUrl,
  createDesktopHttpSessionBroker,
  createDesktopSessionManager,
  consumeDesktopAuthorizationCallback,
  type DesktopSession,
  type DesktopSessionBroker,
  type DesktopSessionVault,
} from '../../src/desktop'

const cloudOrigin = 'https://agent-hq.example'
const sessionId = '018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1'

function callbackUrl(attempt: Awaited<ReturnType<typeof createDesktopAuthorizationAttempt>>) {
  const url = new URL('agent-hq://auth/callback')
  url.searchParams.set('code', 'one-time-code')
  url.searchParams.set('nonce', attempt.nonce)
  url.searchParams.set('state', attempt.state)
  return url.toString()
}

describe('desktop authorization boundary', () => {
  test('completes a cold-start callback from a protected persisted attempt', async () => {
    let stored: Awaited<ReturnType<typeof createDesktopAuthorizationAttempt>> | null = null
    const vault = {
      clear: async () => {
        stored = null
      },
      load: async () => stored,
      save: async (attempt: NonNullable<typeof stored>) => {
        stored = structuredClone(attempt)
      },
    }
    const firstProcess = createDesktopAuthorizationManager({ vault })
    const attempt = await firstProcess.begin()

    const restartedProcess = createDesktopAuthorizationManager({ vault })
    await expect(restartedProcess.consume(callbackUrl(attempt), 1_001)).resolves.toEqual({
      code: 'one-time-code',
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
      redirectUri: 'agent-hq://auth/callback',
    })
    expect(stored).toBeNull()
  })

  test('creates a PKCE authorization request without credentials in the URL', async () => {
    const attempt = await createDesktopAuthorizationAttempt({ now: 1_000 })
    const authorizationUrl = createDesktopAuthorizationUrl(cloudOrigin, attempt)
    const url = new URL(authorizationUrl)

    expect(url.origin).toBe(cloudOrigin)
    expect(url.pathname).toBe('/api/auth/desktop/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(attempt.codeChallenge)
    expect(url.searchParams.get('nonce')).toBe(attempt.nonce)
    expect(url.searchParams.get('state')).toBe(attempt.state)
    expect(authorizationUrl).not.toContain(attempt.codeVerifier)
    expect(authorizationUrl).not.toMatch(/access_token|refresh_token|session_token/i)
  })

  test('consumes one matching, unexpired callback exactly once', async () => {
    const attempt = await createDesktopAuthorizationAttempt({ now: 1_000 })
    const result = consumeDesktopAuthorizationCallback(attempt, callbackUrl(attempt), 1_001)

    expect(result).toEqual({
      code: 'one-time-code',
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
      redirectUri: 'agent-hq://auth/callback',
    })
    expect(() => consumeDesktopAuthorizationCallback(attempt, callbackUrl(attempt), 1_002)).toThrow(
      'already consumed'
    )
  })

  test('rejects wrong-state, expired, untrusted, and credential-bearing callbacks', async () => {
    const wrongState = await createDesktopAuthorizationAttempt({ now: 1_000 })
    const wrongStateUrl = new URL(callbackUrl(wrongState))
    wrongStateUrl.searchParams.set('state', 'attacker-state')
    expect(() =>
      consumeDesktopAuthorizationCallback(wrongState, wrongStateUrl.toString(), 1_001)
    ).toThrow('state mismatch')

    const wrongNonce = await createDesktopAuthorizationAttempt({ now: 1_000 })
    const wrongNonceUrl = new URL(callbackUrl(wrongNonce))
    wrongNonceUrl.searchParams.set('nonce', 'attacker-nonce')
    expect(() =>
      consumeDesktopAuthorizationCallback(wrongNonce, wrongNonceUrl.toString(), 1_001)
    ).toThrow('nonce mismatch')

    const expired = await createDesktopAuthorizationAttempt({ now: 1_000, ttlMs: 5 })
    expect(() => consumeDesktopAuthorizationCallback(expired, callbackUrl(expired), 1_006)).toThrow(
      'expired'
    )

    const untrusted = await createDesktopAuthorizationAttempt({ now: 1_000 })
    expect(() =>
      consumeDesktopAuthorizationCallback(
        untrusted,
        `https://evil.example/callback?code=x&nonce=${untrusted.nonce}&state=${untrusted.state}`,
        1_001
      )
    ).toThrow('not trusted')

    const credentialBearing = await createDesktopAuthorizationAttempt({ now: 1_000 })
    const credentialUrl = new URL(callbackUrl(credentialBearing))
    credentialUrl.searchParams.set('access_token', 'must-not-travel-in-url')
    expect(() =>
      consumeDesktopAuthorizationCallback(credentialBearing, credentialUrl.toString(), 1_001)
    ).toThrow('credentials')
  })
})

describe('desktop session lifecycle', () => {
  test('keeps a newly authenticated session usable when local session persistence fails', async () => {
    const session: DesktopSession = {
      credential: 'opaque-user-session-credential-0000001',
      expiresAt: '2030-01-01T00:00:00.000Z',
      sessionId,
    }
    const vault: DesktopSessionVault = {
      clear: async () => {},
      load: async () => null,
      save: async () => {
        throw new Error('device credential vault unavailable')
      },
    }
    const broker: DesktopSessionBroker = {
      exchange: async () => session,
      logout: async () => {},
      refresh: async () => session,
      revoke: async () => {},
    }

    const manager = createDesktopSessionManager({ broker, vault })
    await expect(
      manager.completeSignIn({
        code: 'one-time-code',
        codeVerifier: 'v'.repeat(43),
        nonce: 'n'.repeat(16),
        redirectUri: 'agent-hq://auth/callback',
      })
    ).resolves.toEqual({ session, status: 'authenticated' })
  })

  test('exchanges and refreshes credentials only in request headers or bodies', async () => {
    const requests: Array<{ input?: RequestInit; url: string }> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      requests.push({ input: init, url })
      if (url.endsWith('/exchange')) {
        return Response.json({
          credential: 'opaque-session-credential-000000001',
          expiresAt: '2030-01-01T00:00:00.000Z',
          sessionId: '018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1',
        })
      }
      if (url.endsWith('/refresh')) {
        return Response.json({
          credential: 'opaque-session-credential-000000002',
          expiresAt: '2030-01-01T01:00:00.000Z',
          sessionId: '018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1',
        })
      }
      return new Response(null, { status: 204 })
    }
    const broker = createDesktopHttpSessionBroker({ cloudOrigin, fetch })
    const attempt = await createDesktopAuthorizationAttempt({ now: 1_000 })
    const session = await broker.exchange({
      code: 'one-time-code',
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
      redirectUri: attempt.redirectUri,
    })
    const refreshed = await broker.refresh(session)
    await broker.logout(refreshed)

    expect(refreshed.credential).toBe('opaque-session-credential-000000002')
    expect(requests.map(({ url }) => url)).toEqual([
      `${cloudOrigin}/api/auth/desktop/exchange`,
      `${cloudOrigin}/api/auth/desktop/refresh`,
      `${cloudOrigin}/api/auth/desktop/logout`,
    ])
    expect(requests.every(({ url }) => !url.includes('opaque-session'))).toBe(true)
    expect(new Headers(requests[1]?.input?.headers).get('authorization')).toBe(
      'Desktop opaque-session-credential-000000001'
    )
    expect(new Headers(requests[1]?.input?.headers).get('x-agent-hq-desktop-session')).toBe(
      '018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1'
    )
  })

  test('refreshes a restored session and fails closed with an explicit offline state', async () => {
    let stored: DesktopSession | null = {
      credential: 'opaque-user-session-credential-0000001',
      expiresAt: '2030-01-01T00:00:00.000Z',
      sessionId,
    }
    const vault: DesktopSessionVault = {
      clear: async () => {
        stored = null
      },
      load: async () => stored,
      save: async (session) => {
        stored = session
      },
    }
    const broker: DesktopSessionBroker = {
      exchange: async () => {
        throw new Error('not used')
      },
      logout: async () => {},
      refresh: async () => {
        throw new TypeError('network unavailable')
      },
      revoke: async () => {},
    }

    const manager = createDesktopSessionManager({ broker, vault })
    expect(await manager.restore()).toEqual({ reason: 'network_unavailable', status: 'offline' })
    expect(stored?.sessionId).toBe(sessionId)
  })

  test('clears a malformed protected session when vault loading fails', async () => {
    let cleared = false
    const vault: DesktopSessionVault = {
      clear: async () => {
        cleared = true
      },
      load: async () => {
        throw new Error('malformed protected session')
      },
      save: async () => {},
    }
    const broker: DesktopSessionBroker = {
      exchange: async () => {
        throw new Error('not used')
      },
      logout: async () => {},
      refresh: async (session) => session,
      revoke: async () => {},
    }

    const manager = createDesktopSessionManager({ broker, vault })
    await expect(manager.restore()).resolves.toEqual({ status: 'unauthenticated' })
    expect(cleared).toBe(true)
  })

  test('falls through to guest startup when the protected session vault does not answer', async () => {
    let cleared = false
    const vault: DesktopSessionVault = {
      clear: async () => {
        cleared = true
      },
      load: () => new Promise<null>(() => undefined),
      save: async () => {},
    }
    const broker: DesktopSessionBroker = {
      exchange: async () => {
        throw new Error('not used')
      },
      logout: async () => {},
      refresh: async (session) => session,
      revoke: async () => {},
    }

    const manager = createDesktopSessionManager({ broker, vault, vaultLoadTimeoutMs: 5 })
    await expect(manager.restore()).resolves.toEqual({ status: 'unauthenticated' })
    expect(cleared).toBe(false)
  })

  test('does not preserve malformed vault data as an offline session', async () => {
    let cleared = false
    let persisted: DesktopSession = {
      credential: 'opaque-user-session-credential-0000001',
      expiresAt: 'not-a-date-1234567890',
      sessionId,
    }
    const vault: DesktopSessionVault = {
      clear: async () => {
        cleared = true
      },
      load: async () => persisted,
      save: async () => {},
    }
    const broker: DesktopSessionBroker = {
      exchange: async () => {
        throw new Error('not used')
      },
      logout: async () => {},
      refresh: async () => {
        throw new TypeError('network unavailable')
      },
      revoke: async () => {},
    }

    const manager = createDesktopSessionManager({ broker, vault })
    await expect(manager.restore()).resolves.toEqual({ status: 'unauthenticated' })
    expect(cleared).toBe(true)

    cleared = false
    persisted = { ...persisted, expiresAt: '2030-01-01T00:00:00.000Z', sessionId: 'invalid-id' }
    const nextManager = createDesktopSessionManager({ broker, vault })
    await expect(nextManager.restore()).resolves.toEqual({ status: 'unauthenticated' })
    expect(cleared).toBe(true)
  })

  test('serializes startup restore before a newly completed sign-in', async () => {
    let releaseRefresh: (() => void) | undefined
    let markRefreshStarted: (() => void) | undefined
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    let stored: DesktopSession | null = {
      credential: 'opaque-old-session-credential-00000001',
      expiresAt: '2030-01-01T00:00:00.000Z',
      sessionId,
    }
    const refreshedOld = { ...stored, credential: 'opaque-old-session-credential-00000002' }
    const signedIn = {
      credential: 'opaque-new-session-credential-00000001',
      expiresAt: '2030-01-01T00:00:00.000Z',
      sessionId: '028fc7c8-4a45-7e7c-9b92-3e5eafca4ed2',
    }
    const vault: DesktopSessionVault = {
      clear: async () => {
        stored = null
      },
      load: async () => stored,
      save: async (session) => {
        stored = session
      },
    }
    const broker: DesktopSessionBroker = {
      exchange: async () => signedIn,
      logout: async () => {},
      refresh: async () => {
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve
          markRefreshStarted?.()
        })
        return refreshedOld
      },
      revoke: async () => {},
    }
    const manager = createDesktopSessionManager({ broker, vault })

    const restoring = manager.restore()
    await refreshStarted
    const signingIn = manager.completeSignIn({
      code: 'one-time-code',
      codeVerifier: 'v'.repeat(64),
      nonce: 'n'.repeat(32),
      redirectUri: 'agent-hq://auth/callback',
    })
    releaseRefresh?.()
    await Promise.all([restoring, signingIn])

    expect(stored).toEqual(signedIn)
  })

  test('sign-out clears only the user session boundary', async () => {
    let stored: DesktopSession | null = {
      credential: 'opaque-user-session-credential-0000001',
      expiresAt: '2030-01-01T00:00:00.000Z',
      sessionId,
    }
    const deviceCredential = 'paired-runtime-node-credential'
    const vault: DesktopSessionVault = {
      clear: async () => {
        stored = null
      },
      load: async () => stored,
      save: async (session) => {
        stored = session
      },
    }
    const broker: DesktopSessionBroker = {
      exchange: async () => {
        throw new Error('not used')
      },
      logout: async () => {},
      refresh: async (session) => session,
      revoke: async () => {},
    }

    const manager = createDesktopSessionManager({ broker, vault })
    await manager.signOut()

    expect(stored).toBeNull()
    expect(deviceCredential).toBe('paired-runtime-node-credential')
  })

  test('clears the local user session when remote logout fails', async () => {
    let stored: DesktopSession | null = {
      credential: 'opaque-user-session-credential-0000001',
      expiresAt: '2030-01-01T00:00:00.000Z',
      sessionId,
    }
    const vault: DesktopSessionVault = {
      clear: async () => {
        stored = null
      },
      load: async () => stored,
      save: async (session) => {
        stored = session
      },
    }
    const broker: DesktopSessionBroker = {
      exchange: async () => {
        throw new Error('not used')
      },
      logout: async () => {
        throw new TypeError('network unavailable')
      },
      refresh: async (session) => session,
      revoke: async () => {},
    }

    const manager = createDesktopSessionManager({ broker, vault })
    await expect(manager.signOut()).rejects.toThrow('network unavailable')
    expect(stored).toBeNull()
  })

  test('attempts to clear the local user session when vault loading fails', async () => {
    let cleared = false
    const manager = createDesktopSessionManager({
      broker: {
        exchange: async () => {
          throw new Error('not used')
        },
        logout: async () => {
          throw new Error('not used')
        },
        refresh: async (session) => session,
        revoke: async () => {
          throw new Error('not used')
        },
      },
      vault: {
        clear: async () => {
          cleared = true
        },
        load: async () => {
          throw new Error('vault unavailable')
        },
        save: async () => {},
      },
    })

    await expect(manager.signOut()).rejects.toThrow('vault unavailable')
    expect(cleared).toBe(true)
  })
})
