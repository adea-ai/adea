import { describe, expect, test } from 'bun:test'

import { memoryAdapter } from 'better-auth/adapters/memory'

import {
  createBetterAuthServer,
  createBetterAuthServerAdapter,
  handleBetterAuthRequest,
  type BetterAuthInstance,
} from '../../src/better-auth-server'
import { readBetterAuthConfig, type BetterAuthConfig } from '../../src/config'
import { createRecordingAuthDelivery } from '../../src/delivery'
import { createAuthorizationState, verifyAuthorizationState } from '../../src/security'

const APP_ORIGIN = 'https://app.test'
const AUTH_ORIGIN = 'https://auth.test'

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

const signup = (email: string) => ({
  email,
  name: 'New Operator',
  password: 'correct horse battery staple',
})

describe('self-hosted Better Auth service (synthetic, memory adapter)', () => {
  test('a new account can sign up, read its own session, and sign out', async () => {
    const { auth, config: settings } = createTestServer()

    const response = await post(auth, settings, '/sign-up/email', signup('new@example.test'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const cookie = cookiesFrom(response)
    expect(cookie).not.toBe('')

    const adapter = adapterWith(auth, cookie)
    const session = await adapter.getSession()
    expect(session?.identity.provider).toBe('better-auth')
    expect(session?.profile.email).toBe('new@example.test')
    expect(session?.profile.displayName).toBe('New Operator')

    await adapter.signOut()
    expect(await adapterWith(auth, cookie).refreshSession()).toBeNull()
  })

  test('denies a duplicate signup and a wrong password without a session', async () => {
    const { auth, config: settings } = createTestServer()
    await post(auth, settings, '/sign-up/email', signup('taken@example.test'))

    await expect(adapterWith(auth).signUp(signup('taken@example.test'))).rejects.toMatchObject({
      message: 'Authentication provider request failed',
    })
    await expect(
      adapterWith(auth).signIn({ email: 'taken@example.test', password: 'wrong password' })
    ).rejects.toMatchObject({ code: 'invalid_email_or_password' })
  })

  test('a signed-in session can be explicitly revoked and then fails closed', async () => {
    const { auth, config: settings } = createTestServer()
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
    const verification = createTestServer({
      config: config({ AUTH_EMAIL_VERIFICATION_REQUIRED: 'true' }),
    })
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

    const reset = createTestServer()
    await post(reset.auth, reset.config, '/sign-up/email', signup('reset@example.test'))
    const resetResponse = await post(reset.auth, reset.config, '/request-password-reset', {
      email: 'reset@example.test',
      redirectTo: `${APP_ORIGIN}/reset`,
    })
    expect(resetResponse.status).toBe(200)
    expect(reset.sent.some((message) => message.kind === 'password-reset')).toBe(true)
  })

  test('keeps two accounts isolated: neither cookie resolves to the other subject', async () => {
    const { auth, config: settings } = createTestServer()
    const first = cookiesFrom(
      await post(auth, settings, '/sign-up/email', signup('a@example.test'))
    )
    const second = cookiesFrom(
      await post(auth, settings, '/sign-up/email', signup('b@example.test'))
    )

    const sessionA = await adapterWith(auth, first).getSession()
    const sessionB = await adapterWith(auth, second).getSession()

    expect(sessionA?.identity.subject).not.toBe(sessionB?.identity.subject)
    expect(sessionA?.profile.email).toBe('a@example.test')
    expect(sessionB?.profile.email).toBe('b@example.test')
    // A cookie is bound to one session: it never reads another account's session.
    expect((await adapterWith(auth, first).refreshSession())?.identity.subject).toBe(
      sessionA?.identity.subject
    )
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
