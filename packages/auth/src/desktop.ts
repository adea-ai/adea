const DESKTOP_CALLBACK_URI = 'agent-hq://auth/callback'
const DEFAULT_AUTHORIZATION_TTL_MS = 5 * 60 * 1_000
const BASE64_URL = /^[A-Za-z0-9_-]+$/u
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const FORBIDDEN_CALLBACK_PARAMETERS = [
  'access_token',
  'id_token',
  'refresh_token',
  'session',
  'session_token',
] as const

export type DesktopAuthorizationAttempt = {
  codeChallenge: string
  codeVerifier: string
  expiresAt: number
  nonce: string
  redirectUri: typeof DESKTOP_CALLBACK_URI
  state: string
  used: boolean
}

export type DesktopAuthorizationExchange = Readonly<{
  code: string
  codeVerifier: string
  nonce: string
  redirectUri: typeof DESKTOP_CALLBACK_URI
}>

export interface DesktopAuthorizationAttemptVault {
  clear(): Promise<void>
  load(): Promise<DesktopAuthorizationAttempt | null>
  save(attempt: DesktopAuthorizationAttempt): Promise<void>
}

function encodeUrlSafe(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function randomUrlSafe(crypto: Crypto, size = 32) {
  return encodeUrlSafe(crypto.getRandomValues(new Uint8Array(size)))
}

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

function assertCloudOrigin(value: string) {
  const url = new URL(value)
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Desktop auth origin must not contain credentials, a path, query, or fragment')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Desktop auth origin must use HTTPS')
  }
  return url.origin
}

export async function createDesktopAuthorizationAttempt({
  crypto = globalThis.crypto,
  now = Date.now(),
  ttlMs = DEFAULT_AUTHORIZATION_TTL_MS,
}: {
  crypto?: Crypto
  now?: number
  ttlMs?: number
} = {}): Promise<DesktopAuthorizationAttempt> {
  if (!crypto?.subtle) throw new Error('Web Crypto is required for desktop authentication')
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_AUTHORIZATION_TTL_MS) {
    throw new Error('Desktop authorization TTL is invalid')
  }

  const codeVerifier = randomUrlSafe(crypto, 48)
  const challenge = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return {
    codeChallenge: encodeUrlSafe(new Uint8Array(challenge)),
    codeVerifier,
    expiresAt: now + ttlMs,
    nonce: randomUrlSafe(crypto),
    redirectUri: DESKTOP_CALLBACK_URI,
    state: randomUrlSafe(crypto),
    used: false,
  }
}

export function createDesktopAuthorizationUrl(
  cloudOrigin: string,
  attempt: DesktopAuthorizationAttempt
) {
  const url = new URL('/api/auth/desktop/authorize', assertCloudOrigin(cloudOrigin))
  url.searchParams.set('client', 'desktop')
  url.searchParams.set('code_challenge', attempt.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('nonce', attempt.nonce)
  url.searchParams.set('redirect_uri', attempt.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', attempt.state)
  return url.toString()
}

export function consumeDesktopAuthorizationCallback(
  attempt: DesktopAuthorizationAttempt,
  rawCallbackUrl: string,
  now = Date.now()
): DesktopAuthorizationExchange {
  if (attempt.used) throw new Error('Desktop authorization was already consumed')
  if (attempt.expiresAt <= now) throw new Error('Desktop authorization expired')

  const callback = new URL(rawCallbackUrl)
  if (`${callback.protocol}//${callback.host}${callback.pathname}` !== DESKTOP_CALLBACK_URI) {
    throw new Error('Desktop authorization callback is not trusted')
  }
  if (FORBIDDEN_CALLBACK_PARAMETERS.some((parameter) => callback.searchParams.has(parameter))) {
    throw new Error('Desktop authorization callback must not contain credentials')
  }
  const parameterNames = [...callback.searchParams.keys()]
  if (new Set(parameterNames).size !== parameterNames.length) {
    throw new Error('Desktop authorization callback contains duplicate parameters')
  }

  const code = callback.searchParams.get('code') ?? ''
  const nonce = callback.searchParams.get('nonce') ?? ''
  const state = callback.searchParams.get('state') ?? ''
  if (code.length < 8 || code.length > 512) throw new Error('Desktop authorization code is invalid')
  if (!constantTimeEqual(attempt.state, state))
    throw new Error('Desktop authorization state mismatch')
  if (!constantTimeEqual(attempt.nonce, nonce))
    throw new Error('Desktop authorization nonce mismatch')

  attempt.used = true
  return { code, codeVerifier: attempt.codeVerifier, nonce, redirectUri: DESKTOP_CALLBACK_URI }
}

export function createDesktopAuthorizationManager({
  createAttempt = createDesktopAuthorizationAttempt,
  vault,
}: {
  createAttempt?: () => Promise<DesktopAuthorizationAttempt>
  vault: DesktopAuthorizationAttemptVault
}) {
  return {
    async begin() {
      const attempt = await createAttempt()
      await vault.save(attempt)
      return attempt
    },
    cancel: () => vault.clear(),
    async consume(rawCallbackUrl: string, now = Date.now()) {
      const attempt = await vault.load()
      if (!attempt) throw new Error('Desktop authorization attempt is unavailable')
      const exchange = consumeDesktopAuthorizationCallback(attempt, rawCallbackUrl, now)
      await vault.clear()
      return exchange
    },
  }
}

export type DesktopSession = Readonly<{
  credential: string
  expiresAt: string
  sessionId: string
}>

export type DesktopSessionExchangeInput = DesktopAuthorizationExchange

export interface DesktopSessionVault {
  clear(): Promise<void>
  load(): Promise<DesktopSession | null>
  save(session: DesktopSession): Promise<void>
}

export interface DesktopSessionBroker {
  exchange(input: DesktopSessionExchangeInput): Promise<DesktopSession>
  logout(session: DesktopSession): Promise<void>
  refresh(session: DesktopSession): Promise<DesktopSession>
  revoke(session: DesktopSession): Promise<void>
}

function parseDesktopSession(value: unknown): DesktopSession {
  if (!value || typeof value !== 'object') throw new Error('Desktop session response is invalid')
  const candidate = value as Partial<DesktopSession>
  const expiresAt = candidate.expiresAt ? new Date(candidate.expiresAt) : undefined
  if (
    typeof candidate.credential !== 'string' ||
    candidate.credential.length < 32 ||
    candidate.credential.length > 512 ||
    !BASE64_URL.test(candidate.credential) ||
    typeof candidate.sessionId !== 'string' ||
    !SESSION_ID.test(candidate.sessionId) ||
    !expiresAt ||
    Number.isNaN(expiresAt.valueOf())
  ) {
    throw new Error('Desktop session response is invalid')
  }
  return Object.freeze({
    credential: candidate.credential,
    expiresAt: expiresAt.toISOString(),
    sessionId: candidate.sessionId,
  })
}

export function createDesktopHttpSessionBroker({
  cloudOrigin,
  fetch = globalThis.fetch,
}: {
  cloudOrigin: string
  fetch?: typeof globalThis.fetch
}): DesktopSessionBroker {
  const origin = assertCloudOrigin(cloudOrigin)

  async function request(path: string, init: RequestInit) {
    const response = await fetch(new URL(path, origin), {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    })
    if (!response.ok) throw new Error('Desktop session request failed')
    return response
  }

  async function authenticatedRequest(path: string, session: DesktopSession) {
    const response = await request(path, {
      headers: {
        authorization: `Desktop ${session.credential}`,
        'x-agent-hq-desktop-session': session.sessionId,
      },
      method: 'POST',
    })
    if (response.status === 204) return null
    return parseDesktopSession(await response.json())
  }

  return {
    async exchange(input) {
      const response = await request('/api/auth/desktop/exchange', {
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      return parseDesktopSession(await response.json())
    },
    async logout(session) {
      await authenticatedRequest('/api/auth/desktop/logout', session)
    },
    async refresh(session) {
      const refreshed = await authenticatedRequest('/api/auth/desktop/refresh', session)
      if (!refreshed) throw new Error('Desktop session response is invalid')
      return refreshed
    },
    async revoke(session) {
      await authenticatedRequest('/api/auth/desktop/revoke', session)
    },
  }
}

export type DesktopSessionState =
  | Readonly<{ session: DesktopSession; status: 'authenticated' }>
  | Readonly<{ reason: 'network_unavailable'; status: 'offline' }>
  | Readonly<{ status: 'unauthenticated' }>

function isNetworkUnavailable(error: unknown) {
  return error instanceof TypeError
}

export function createDesktopSessionManager({
  broker,
  vault,
  vaultLoadTimeoutMs = 1_500,
}: {
  broker: DesktopSessionBroker
  vault: DesktopSessionVault
  vaultLoadTimeoutMs?: number
}) {
  if (!Number.isFinite(vaultLoadTimeoutMs) || vaultLoadTimeoutMs <= 0) {
    throw new Error('Desktop session vault timeout is invalid')
  }
  let pending: Promise<void> = Promise.resolve()
  const vaultLoadTimedOut = Symbol('vault-load-timed-out')

  async function loadVaultForStartup() {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        vault.load(),
        new Promise<typeof vaultLoadTimedOut>((resolve) => {
          timeout = setTimeout(() => resolve(vaultLoadTimedOut), vaultLoadTimeoutMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  async function persistSession(session: DesktopSession) {
    await vault.save(session).catch(() => undefined)
  }

  function serialize<T>(operation: () => Promise<T>) {
    const result = pending.then(operation, operation)
    pending = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  return {
    completeSignIn(input: DesktopSessionExchangeInput): Promise<DesktopSessionState> {
      return serialize(async () => {
        const session = await broker.exchange(input)
        await persistSession(session)
        return { session, status: 'authenticated' as const }
      })
    },
    restore(): Promise<DesktopSessionState> {
      return serialize(async () => {
        let stored: DesktopSession | null
        try {
          const value = await loadVaultForStartup()
          if (value === vaultLoadTimedOut) return { status: 'unauthenticated' as const }
          stored = value ? parseDesktopSession(value) : null
          if (stored && Date.parse(stored.expiresAt) <= Date.now()) {
            throw new Error('Desktop session expired')
          }
        } catch {
          await vault.clear().catch(() => undefined)
          return { status: 'unauthenticated' as const }
        }
        if (!stored) return { status: 'unauthenticated' as const }
        try {
          const session = await broker.refresh(stored)
          await persistSession(session)
          return { session, status: 'authenticated' as const }
        } catch (error) {
          if (isNetworkUnavailable(error)) {
            return { reason: 'network_unavailable' as const, status: 'offline' as const }
          }
          await vault.clear()
          return { status: 'unauthenticated' as const }
        }
      })
    },
    revoke(): Promise<void> {
      return serialize(async () => {
        const stored = await vault.load()
        try {
          if (stored) await broker.revoke(stored)
        } finally {
          await vault.clear()
        }
      })
    },
    signOut(): Promise<void> {
      return serialize(async () => {
        try {
          const stored = await vault.load()
          if (stored) await broker.logout(stored)
        } finally {
          await vault.clear()
        }
      })
    },
  }
}

export { DESKTOP_CALLBACK_URI }
