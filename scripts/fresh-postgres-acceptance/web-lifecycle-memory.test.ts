import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'bun:test'

const root = process.env.FRESH_AUTH_SOURCE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url))
const source = (name: string) => pathToFileURL(resolve(root, 'packages/auth/src', name)).href
const requireAuth = createRequire(resolve(root, 'packages/auth/package.json'))

const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')

test.skipIf(process.env.FRESH_AUTH_ACCEPTANCE !== '1' && !process.env.FRESH_AUTH_SOURCE_ROOT)(
  'dedicated opt-in: verified fresh web account resets once, rejects expired reset and session replay, and logs out',
  async () => {
    const { memoryAdapter } = await import(
      pathToFileURL(requireAuth.resolve('better-auth/adapters/memory')).href
    )
    const { createBetterAuthServer, createBetterAuthServerAdapter, handleBetterAuthRequest } =
      await import(source('better-auth-server.ts'))
    const { readBetterAuthConfig } = await import(source('config.ts'))
    const { createRecordingAuthDelivery } = await import(source('delivery.ts'))

    const origin = 'https://fresh.example.test'
    const email = 'fresh-web@example.test'
    const oldPassword = 'synthetic old web acceptance password'
    const newPassword = 'synthetic new web acceptance password'
    const records = {
      user: [] as any[],
      account: [] as any[],
      session: [] as any[],
      verification: [] as any[],
    }
    const recorder = createRecordingAuthDelivery()
    const config = readBetterAuthConfig({
      AUTH_BASE_URL: origin,
      AUTH_DATABASE_URL: 'postgres://unused@127.0.0.1/unused',
      AUTH_SECRET: 'synthetic-memory-acceptance-secret-long-enough',
      AUTH_TRUSTED_ORIGINS: origin,
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
      AUTH_SECURE_COOKIES: 'true',
    })
    const auth = createBetterAuthServer({
      config,
      database: memoryAdapter(records),
      delivery: recorder.delivery,
    })

    const adapter = (value: string) =>
      createBetterAuthServerAdapter(auth, new Headers({ cookie: value, origin }))
    async function request(
      path: string,
      body?: Record<string, unknown>,
      value = '',
      requestOrigin: string | null = origin
    ): Promise<Response> {
      const method = body === undefined ? 'GET' : 'POST'
      const headers = new Headers()
      if (requestOrigin !== null) headers.set('origin', requestOrigin)
      if (value) headers.set('cookie', value)
      if (body) headers.set('content-type', 'application/json')
      const response = await handleBetterAuthRequest(
        auth,
        method,
        new Request(`${origin}/api/auth${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        config
      )
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('pragma'), 'no-cache')
      assert.equal(response.headers.get('expires'), '0')
      return response
    }
    const signup = await request('/sign-up/email', {
      email,
      name: 'Fresh Web',
      password: oldPassword,
    })
    assert.equal(signup.status, 200)
    assert.equal(cookie(signup), '')
    assert.equal(records.session.length, 0)
    assert.equal(recorder.sent.length, 1)
    assert.equal(recorder.sent[0].kind, 'verification')
    const denied = await request('/sign-in/email', { email, password: oldPassword })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).code, 'EMAIL_NOT_VERIFIED')
    const verified = await request(
      `/verify-email?token=${encodeURIComponent(recorder.sent[0].token)}`
    )
    assert.equal(verified.status, 200)
    const verifiedCookie = cookie(verified)
    assert.ok(verifiedCookie)
    assert.ok(
      verified.headers
        .getSetCookie()
        .some(
          (value) => /HttpOnly/i.test(value) && /Secure/i.test(value) && /SameSite=Lax/i.test(value)
        )
    )
    assert.equal((await adapter(verifiedCookie).getSession())?.profile.email, email)
    async function login(password: string) {
      const response = await request('/sign-in/email', { email, password })
      assert.equal(response.status, 200)
      assert.ok(cookie(response))
      return cookie(response)
    }
    const priorCookie = await login(oldPassword)
    const beforeDenied = recorder.sent.length
    for (const requestOrigin of [null, 'https://hostile.example.test']) {
      assert.equal(
        (
          await request(
            '/request-password-reset',
            { email, redirectTo: `${origin}/reset` },
            priorCookie,
            requestOrigin
          )
        ).status,
        403
      )
      assert.equal(recorder.sent.length, beforeDenied)
    }
    assert.equal(
      (await request('/request-password-reset', { email, redirectTo: `${origin}/reset` })).status,
      200
    )
    const token = recorder.sent.filter((entry: any) => entry.kind === 'password-reset')[0].token
    assert.equal((await request('/reset-password', { token, newPassword })).status, 200)
    assert.equal(records.session.length, 0)
    for (const value of [priorCookie, verifiedCookie])
      assert.equal(await adapter(value).refreshSession(), null)
    const replay = await request('/reset-password', {
      token,
      newPassword: 'unused synthetic replay password',
    })
    assert.equal(replay.status, 400)
    assert.equal((await replay.json()).code, 'INVALID_TOKEN')
    const oldLogin = await request('/sign-in/email', { email, password: oldPassword })
    assert.equal(oldLogin.status, 401)
    assert.equal(cookie(oldLogin), '')
    const currentCookie = await login(newPassword)
    assert.equal((await request('/sign-out', {}, currentCookie)).status, 200)
    assert.equal(await adapter(currentCookie).refreshSession(), null)
    assert.equal(records.session.length, 0)
    assert.equal(
      (await request('/request-password-reset', { email, redirectTo: `${origin}/reset` })).status,
      200
    )
    const resets = recorder.sent.filter((entry: any) => entry.kind === 'password-reset')
    assert.equal(resets.length, 2)
    const expiredToken = resets[1].token
    const expirationRows = records.verification.filter(
      (entry) => entry.identifier === `reset-password:${expiredToken}`
    )
    assert.equal(expirationRows.length, 1)
    expirationRows[0].expiresAt = new Date('2000-01-01T00:00:00Z')
    const expired = await request('/reset-password', {
      token: expiredToken,
      newPassword: 'unused synthetic expiry password',
    })
    assert.equal(expired.status, 400)
    assert.equal((await expired.json()).code, 'INVALID_TOKEN')
    assert.equal(cookie(expired), '')
    assert.equal(records.session.length, 0)
    const lastCookie = await login(newPassword)
    const session = await adapter(lastCookie).getSession()
    assert.ok(session)
    await adapter(lastCookie).revokeSession(session.session.id)
    assert.equal(await adapter(lastCookie).refreshSession(), null)
    assert.equal(records.session.length, 0)
  }
)
