import { describe, expect, test } from 'bun:test'
import { createAuthClient } from 'better-auth/client'

import { createNeonClientAdapter, type BetterAuthBrowserClient } from '../../src/client'
import { AUTH_ERROR_CODES } from '../../src/errors'

// The response shapes the pinned Better Auth 1.6.23 browser client actually
// produces. `signIn.email` / `signUp.email` resolve to the credential payload
// (`{ redirect, token, url, user }`, or `{ token: null, user }` when the
// deployment requires verification), and only `getSession` resolves to a
// session. The adapter must recover the session from `getSession`, never from
// the credential payload.
const user = {
  id: 'provider-subject-1',
  email: 'operator@example.test',
  emailVerified: true,
  name: 'Operator',
}
const session = {
  id: 'provider-session-1',
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  token: 'provider-session-token',
  userId: user.id,
}
const credentialPayload = { redirect: false, token: session.token, url: null, user }

function fakeClient(overrides: Partial<BetterAuthBrowserClient> = {}): BetterAuthBrowserClient {
  return {
    getSession: async () => ({ data: { session, user }, error: null }),
    listSessions: async () => ({ data: [], error: null }),
    revokeSession: async () => ({ data: { status: true }, error: null }),
    signIn: { email: async () => ({ data: credentialPayload, error: null }) },
    signUp: { email: async () => ({ data: credentialPayload, error: null }) },
    signOut: async () => ({ data: { success: true }, error: null }),
    ...overrides,
  }
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

describe('Better Auth browser client adapter', () => {
  test('sign-in normalizes the session read after the credential call', async () => {
    const result = await createNeonClientAdapter(fakeClient()).signIn({
      email: user.email,
      password: 'test password long enough',
    })
    expect(result.identity).toEqual({ provider: 'better-auth', subject: user.id })
    expect(result.session).toEqual({
      expiresAt: session.expiresAt.toISOString(),
      id: session.id,
    })
    expect(result.profile).toEqual({ displayName: user.name, email: user.email })
  })

  test('sign-in reads the freshly established session once, not the credential payload', async () => {
    let reads = 0
    const client = fakeClient({
      getSession: async () => {
        reads += 1
        return { data: { session, user }, error: null }
      },
    })
    await createNeonClientAdapter(client).signIn({
      email: user.email,
      password: 'test password long enough',
    })
    // The credential payload cannot be normalized (no session.id/expiresAt), so
    // a successful sign-in proves the adapter read the session instead.
    expect(reads).toBe(1)
  })

  test('sign-up normalizes the session read after the credential call', async () => {
    const result = await createNeonClientAdapter(fakeClient()).signUp({
      email: user.email,
      name: user.name,
      password: 'test password long enough',
    })
    expect(result.session.expiresAt).toBe(session.expiresAt.toISOString())
    expect(result.profile.email).toBe(user.email)
  })

  test('verification-pending signup does not adopt a pre-existing account session', async () => {
    // With requireEmailVerification, `signUp.email` returns `{ token: null,
    // user }` and establishes no session. The browser still holds another
    // account's cookie, so reading `getSession` would return that unrelated
    // account as this signup's result.
    const otherUser = { ...user, id: 'other-subject', email: 'other@example.test' }
    const otherSession = { ...session, id: 'other-session', userId: otherUser.id }
    let reads = 0
    const client = fakeClient({
      signUp: { email: async () => ({ data: { token: null, user }, error: null }) },
      getSession: async () => {
        reads += 1
        return { data: { session: otherSession, user: otherUser }, error: null }
      },
    })
    const failure = await capture(
      createNeonClientAdapter(client).signUp({
        email: user.email,
        name: user.name,
        password: 'test password long enough',
      })
    )
    expect(failure).toMatchObject({ code: AUTH_ERROR_CODES.emailNotVerified })
    expect((failure as { isCredentialRejection: boolean }).isCredentialRejection).toBe(true)
    // The pre-existing cookie must never be read, let alone returned.
    expect(reads).toBe(0)
  })

  test('a session that does not match the credential subject is refused', async () => {
    // Successful sign-in for `user`, but the cookie still resolves to a stale
    // account; the mismatched session must not be handed back.
    const staleUser = { ...user, id: 'stale-subject', email: 'stale@example.test' }
    const staleSession = { ...session, id: 'stale-session', userId: staleUser.id }
    const client = fakeClient({
      getSession: async () => ({ data: { session: staleSession, user: staleUser }, error: null }),
    })
    const failure = await capture(
      createNeonClientAdapter(client).signIn({
        email: user.email,
        password: 'test password long enough',
      })
    )
    expect(failure).toMatchObject({ code: AUTH_ERROR_CODES.sessionNotFound })
  })

  test('a rejected credential call keeps its provider code and never reads a session', async () => {
    let reads = 0
    const client = fakeClient({
      signIn: { email: async () => ({ data: null, error: { code: 'INVALID_EMAIL_OR_PASSWORD' } }) },
      getSession: async () => {
        reads += 1
        return { data: null, error: null }
      },
    })
    const failure = await capture(
      createNeonClientAdapter(client).signIn({
        email: user.email,
        password: 'not the right password',
      })
    )
    expect(failure).toMatchObject({ code: 'invalid_email_or_password' })
    expect(reads).toBe(0)
  })

  test('an unverified account surfaces no email on the normalized session', async () => {
    const client = fakeClient({
      getSession: async () => ({
        data: { session, user: { ...user, emailVerified: false } },
        error: null,
      }),
    })
    const result = await createNeonClientAdapter(client).signIn({
      email: user.email,
      password: 'test password long enough',
    })
    expect(result.profile.email).toBeUndefined()
  })

  test('normalizes a sign-in through the real browser client', async () => {
    // Drive the pinned browser client itself (with a stubbed transport) so the
    // test proves the adapter against the shapes Better Auth actually emits,
    // not only a hand-written fake.
    const requests: string[] = []
    const client = createAuthClient({
      baseURL: 'http://localhost:8787/api/auth',
      fetchOptions: {
        customFetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
          const href =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const path = new URL(href).pathname
          requests.push(`${init?.method ?? 'GET'} ${path}`)
          const body = path.endsWith('/sign-in/email') ? credentialPayload : { session, user }
          return new Response(JSON.stringify(body), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          })
        },
      },
    })

    const result = await createNeonClientAdapter(client).signIn({
      email: user.email,
      password: 'test password long enough',
    })
    expect(result.session).toEqual({
      expiresAt: session.expiresAt.toISOString(),
      id: session.id,
    })
    expect(result.profile.email).toBe(user.email)
    // The credential endpoint returns no session, so the adapter must have read
    // the session endpoint after it.
    expect(requests).toContain('POST /api/auth/sign-in/email')
    expect(requests).toContain('GET /api/auth/get-session')
  })
})
