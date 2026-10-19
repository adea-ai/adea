import { describe, expect, test } from 'bun:test'

import { memoryAdapter } from 'better-auth/adapters/memory'

import {
  createBetterAuthContextAdapter,
  createBetterAuthServer,
  createBetterAuthServerAdapter,
  handleBetterAuthRequest,
  type AuthCookieOptions,
  type AuthRequestContext,
  type BetterAuthInstance,
} from '../../src/better-auth-server'
import { readBetterAuthConfig, type BetterAuthConfig } from '../../src/config'
import { createRecordingAuthDelivery } from '../../src/delivery'
import { createAuthorizationState, verifyAuthorizationState } from '../../src/security'

const APP_ORIGIN = 'https://app.test'
const AUTH_ORIGIN = 'https://auth.test'
const PASSWORD = 'correct horse battery staple'

function config(overrides: Partial<BetterAuthConfig> = {}): BetterAuthConfig {
  return readBetterAuthConfig({
    AUTH_BASE_URL: AUTH_ORIGIN,
    AUTH_DATABASE_URL: 'postgres://unused@localhost:5432/unused',
    AUTH_SECRET: 'synthetic-better-auth-secret-that-is-long-enough',
    AUTH_TRUSTED_ORIGINS: `${APP_ORIGIN},adea://auth/callback`,
    ...overrides,
  })
}

function createTestServer(options: { config?: BetterAuthConfig } = {}) {
  const recorder = createRecordingAuthDelivery()
  const settings = options.config ?? config()
  const auth = createBetterAuthServer({
    config: settings,
    // The memory adapter reads explicit collections; there is no live database.
    database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
    delivery: recorder.delivery,
  })
  return { auth, config: settings, sent: recorder.sent }
}

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0]!)
    .join('; ')
}

function adapterWith(auth: BetterAuthInstance, cookie?: string) {
  const headers = new Headers({ origin: APP_ORIGIN })
  if (cookie) headers.set('cookie', cookie)
  return createBetterAuthServerAdapter(auth, headers)
}

async function post(
  auth: BetterAuthInstance,
  settings: BetterAuthConfig,
  path: string,
  body: Record<string, unknown>,
  origin: string | null = APP_ORIGIN
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin) headers.set('origin', origin)
  return handleBetterAuthRequest(
    auth,
    'POST',
    new Request(`${AUTH_ORIGIN}/api/auth${path}`, {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
    }),
    settings
  )
}

const signup = (email: string) => ({ email, name: 'New Operator', password: PASSWORD })

/**
 * A minimal, in-memory stand-in for the Start/Worker response context: it reads
 * cookies from the jar and records every `setCookie` write the auth service
 * makes, so a test can prove the session cookie survives a real adapter call.
 */
function createMemoryContext(seed: readonly string[] = []) {
  const jar = new Map<string, string>()
  const writes: Array<{ name: string; value: string; options: AuthCookieOptions }> = []
  for (const entry of seed) {
    const pair = entry.split(';')[0] ?? ''
    const [name, ...rest] = pair.split('=')
    if (name) jar.set(name, rest.join('='))
  }
  const header = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  const context: AuthRequestContext = {
    getCookies: header,
    getHeader: () => undefined,
    getOrigin: () => APP_ORIGIN,
    setCookie: (name, value, options) => {
      writes.push({ name, value, options })
      if (!value) jar.delete(name)
      else jar.set(name, value)
    },
  }
  return { context, writes, header }
}

const sessionCookieWrites = (writes: readonly { name: string }[]) =>
  writes.filter((write) => write.name.includes('session_token'))

describe('self-hosted Better Auth service (synthetic, memory adapter)', () => {
  test('a fresh unverified signup gets no session and cannot sign in', async () => {
    const { auth, config: settings, sent } = createTestServer()
    expect(settings.emailVerificationRequired).toBe(true)

    const response = await post(auth, settings, '/sign-up/email', signup('unverified@example.test'))
    expect(response.status).toBe(200)
    // Verification-required signup issues no session cookie.
    expect(cookiesFrom(response)).toBe('')
    expect(sent).toHaveLength(1)

    const memory = createMemoryContext()
    const adapter = createBetterAuthContextAdapter(auth, () => memory.context)
    expect(await adapter.getSession()).toBeNull()
    await expect(
      adapter.signIn({ email: 'unverified@example.test', password: PASSWORD })
    ).rejects.toMatchObject({ code: 'email_not_verified' })
  })

  test('verifying the mailbox attaches the email to the session', async () => {
    const { auth, config: settings, sent } = createTestServer()
    await post(auth, settings, '/sign-up/email', signup('confirm@example.test'))
    const token = sent[0]?.token
    expect(token).toBeTruthy()

    const verified = await handleBetterAuthRequest(
      auth,
      'GET',
      new Request(`${AUTH_ORIGIN}/api/auth/verify-email?token=${token}`, {
        headers: { origin: APP_ORIGIN },
        method: 'GET',
      }),
      settings
    )
    const cookie = cookiesFrom(verified)
    expect(cookie).not.toBe('')

    const session = await adapterWith(auth, cookie).getSession()
    expect(session?.profile.email).toBe('confirm@example.test')
  })

  test('a new account can sign up, read its own session, and sign out', async () => {
    // Loopback development may run without mailbox proof; the flow still signs
    // in, and the identity survives even though the email is not yet verified.
    const { auth, config: settings } = createTestServer({
      config: config({ AUTH_EMAIL_VERIFICATION_REQUIRED: 'false' }),
    })

    const response = await post(auth, settings, '/sign-up/email', signup('new@example.test'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const cookie = cookiesFrom(response)
    expect(cookie).not.toBe('')

    const adapter = adapterWith(auth, cookie)
    const session = await adapter.getSession()
    expect(session?.identity.provider).toBe('better-auth')
    expect(session?.profile.displayName).toBe('New Operator')

    await adapter.signOut()
    expect(await adapterWith(auth, cookie).refreshSession()).toBeNull()
  })

  test('denies a duplicate signup and a wrong password without a session', async () => {
    const { auth, config: settings } = createTestServer({
      config: config({ AUTH_EMAIL_VERIFICATION_REQUIRED: 'false' }),
    })
    await post(auth, settings, '/sign-up/email', signup('taken@example.test'))

    await expect(adapterWith(auth).signUp(signup('taken@example.test'))).rejects.toMatchObject({
      message: 'Authentication provider request failed',
    })
    await expect(
      adapterWith(auth).signIn({ email: 'taken@example.test', password: 'wrong password' })
    ).rejects.toMatchObject({ code: 'invalid_email_or_password' })
  })

  test('a signed-in session can be explicitly revoked and then fails closed', async () => {
    const { auth, config: settings } = createTestServer({
      config: config({ AUTH_EMAIL_VERIFICATION_REQUIRED: 'false' }),
    })
    const response = await post(auth, settings, '/sign-up/email', signup('revoke@example.test'))
    const cookie = cookiesFrom(response)

    const adapter = adapterWith(auth, cookie)
    const session = await adapter.getSession()
    expect(session).not.toBeNull()
    await adapter.revokeSession(session!.session.id)
    expect(await adapterWith(auth, cookie).refreshSession()).toBeNull()
  })

  test('rejects a state-changing request whose origin is not trusted', async () => {
    const { auth, config: settings } = createTestServer()
    const response = await post(
      auth,
      settings,
      '/sign-up/email',
      signup('evil@example.test'),
      'https://evil.test'
    )
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  test('routes verification and reset through the injected delivery, never real email', async () => {
    const verification = createTestServer()
    await post(
      verification.auth,
      verification.config,
      '/sign-up/email',
      signup('verify@example.test')
    )
    expect(verification.sent).toHaveLength(1)
    expect(verification.sent[0]).toMatchObject({
      email: 'verify@example.test',
      kind: 'verification',
    })
    expect(verification.sent[0]!.url).toContain('token=')

    const reset = createTestServer({
      config: config({ AUTH_EMAIL_VERIFICATION_REQUIRED: 'false' }),
    })
    await post(reset.auth, reset.config, '/sign-up/email', signup('reset@example.test'))
    const resetResponse = await post(reset.auth, reset.config, '/request-password-reset', {
      email: 'reset@example.test',
      redirectTo: `${APP_ORIGIN}/reset`,
    })
    expect(resetResponse.status).toBe(200)
    expect(reset.sent.some((message) => message.kind === 'password-reset')).toBe(true)
  })

  test('keeps two accounts isolated: neither cookie resolves to the other subject', async () => {
    const { auth, config: settings } = createTestServer({
      config: config({ AUTH_EMAIL_VERIFICATION_REQUIRED: 'false' }),
    })
    const first = cookiesFrom(
      await post(auth, settings, '/sign-up/email', signup('a@example.test'))
    )
    const second = cookiesFrom(
      await post(auth, settings, '/sign-up/email', signup('b@example.test'))
    )

    const sessionA = await adapterWith(auth, first).getSession()
    const sessionB = await adapterWith(auth, second).getSession()

    expect(sessionA?.identity.subject).not.toBe(sessionB?.identity.subject)
    // A cookie is bound to one session: it never reads another account's session.
    expect((await adapterWith(auth, first).refreshSession())?.identity.subject).toBe(
      sessionA?.identity.subject
    )
  })

  test('persists signup, sign-in, and account-switch cookies through the context adapter', async () => {
    const { auth } = createTestServer({
      config: config({ AUTH_EMAIL_VERIFICATION_REQUIRED: 'false' }),
    })

    // Account B exists first, created through its own context.
    const secondContext = createMemoryContext()
    await createBetterAuthContextAdapter(auth, () => secondContext.context).signUp(
      signup('second@example.test')
    )

    // Account A signs up through its context; the issued cookie must land in
    // the context and resolve A on the next read.
    const context = createMemoryContext()
    const adapter = createBetterAuthContextAdapter(auth, () => context.context)
    const created = await adapter.signUp(signup('first@example.test'))
    expect(sessionCookieWrites(context.writes).length).toBeGreaterThan(0)
    const beforeSwitch = await adapter.getSession()
    expect(beforeSwitch?.identity.subject).toBe(created.identity.subject)

    // Switching accounts on the same jar must read the NEW account: the
    // credential call reads through the cookie it just set, not the stale one.
    const switched = await adapter.signIn({ email: 'second@example.test', password: PASSWORD })
    expect(switched.identity.subject).not.toBe(created.identity.subject)
    const afterSwitch = await adapter.getSession()
    expect(afterSwitch?.identity.subject).toBe(switched.identity.subject)
  })

  test('renews the session cookie through the context adapter', async () => {
    const { auth } = createTestServer({
      config: config({
        AUTH_EMAIL_VERIFICATION_REQUIRED: 'false',
        AUTH_SESSION_UPDATE_AGE_SECONDS: '1',
      }),
    })
    const context = createMemoryContext()
    const adapter = createBetterAuthContextAdapter(auth, () => context.context)
    await adapter.signUp(signup('renew@example.test'))
    const writesBeforeRenewal = context.writes.length

    await new Promise((resolve) => setTimeout(resolve, 1100))
    const renewed = await adapter.refreshSession()

    expect(renewed).not.toBeNull()
    // A renewal rewrites the session cookie; the write must reach the context.
    expect(context.writes.length).toBeGreaterThan(writesBeforeRenewal)
    expect(await adapter.getSession()).not.toBeNull()
  })

  test('clears the session cookie through the context adapter on logout', async () => {
    const { auth } = createTestServer({
      config: config({ AUTH_EMAIL_VERIFICATION_REQUIRED: 'false' }),
    })
    const context = createMemoryContext()
    const adapter = createBetterAuthContextAdapter(auth, () => context.context)
    await adapter.signUp(signup('logout@example.test'))
    expect(await adapter.getSession()).not.toBeNull()

    await adapter.signOut()

    expect(await adapter.getSession()).toBeNull()
    // The clearing write is a session-cookie write carrying an empty value.
    expect(sessionCookieWrites(context.writes).at(-1)?.value).toBe('')
  })

  test('PKCE authorization state is single-use (replay fails closed)', async () => {
    const transaction = await createAuthorizationState({
      redirectUri: `${APP_ORIGIN}/callback`,
      trustedOrigins: [APP_ORIGIN],
    })
    const callback = {
      nonce: transaction.nonce,
      redirectUri: `${APP_ORIGIN}/callback`,
      state: transaction.state,
    }
    expect(await verifyAuthorizationState(transaction, callback)).toBe(true)
    await expect(verifyAuthorizationState(transaction, callback)).rejects.toThrow(
      'already consumed'
    )
  })
})
