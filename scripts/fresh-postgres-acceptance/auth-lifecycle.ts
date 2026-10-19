import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { createDatabase } from '../../packages/db/src/connection'
type ProviderSql = ReturnType<typeof createDatabase>['client']

import {
  createBetterAuthServerAdapter,
  handleBetterAuthRequest,
} from '../../packages/auth/src/better-auth-server'
import type { createRecordingAuthDelivery } from '../../packages/auth/src/delivery'
import type { createBetterAuthService } from '../../packages/auth/src/server'

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')

/**
 * Test-only lifecycle; caller owns fresh schema initialization and cleanup.
 * Requires #1466 APIs. Does not provision, migrate, import data, or send email.
 * Run under the react-server condition used by existing auth integration tests.
 */
export async function runFreshAuthAcceptance(
  service: ReturnType<typeof createBetterAuthService>,
  recorder: ReturnType<typeof createRecordingAuthDelivery>,
  providerSql: ProviderSql
) {
  assert.equal(service.config.emailVerificationRequired, true)
  assert.equal(recorder.sent.length, 0, 'delivery recorder must be fresh')
  const origin = new URL(service.config.baseUrl).origin
  assert.ok(service.config.trustedOrigins.includes(origin), 'fixture origin must be trusted')
  const email = `fresh-${randomUUID()}@example.test`
  const oldPassword = 'synthetic old acceptance password'
  const newPassword = 'synthetic replacement acceptance password'
  const adapter = (cookie: string) =>
    createBetterAuthServerAdapter(service.auth, new Headers({ cookie, origin }))

  async function request(
    path: string,
    body?: Record<string, unknown>,
    cookie = '',
    requestOrigin: string | null = origin
  ) {
    const method = body === undefined ? 'GET' : 'POST'
    const headers = new Headers()
    if (requestOrigin !== null) headers.set('origin', requestOrigin)
    if (cookie) headers.set('cookie', cookie)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const response = await handleBetterAuthRequest(
      service.auth,
      method,
      new Request(`${origin}/api/auth${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      service.config
    )
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('pragma'), 'no-cache')
    assert.equal(response.headers.get('expires'), '0')
    return response
  }
  async function sessionCount() {
    const result = await providerSql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM "session" s JOIN "user" u ON u.id = s."userId" WHERE u.email = ${email}`
    return result[0]?.count
  }
  async function user() {
    const result = await providerSql<
      { id: string; emailVerified: boolean }[]
    >`SELECT id, "emailVerified" FROM "user" WHERE email = ${email}`
    assert.equal(result.length, 1)
    return result[0]!
  }
  // Fixture must start with no provider identities or sessions, not legacy imports.
  for (const table of ['user', 'account', 'session', 'verification']) {
    const result = await providerSql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM ${providerSql(table)}`
    assert.equal(result[0]?.count, 0, `fresh ${table} table must be empty`)
  }

  const signup = await request('/sign-up/email', {
    email,
    name: 'Fresh Operator',
    password: oldPassword,
  })
  assert.equal(signup.status, 200)
  assert.equal(cookies(signup), '')
  assert.equal((await user()).emailVerified, false)
  assert.equal(await sessionCount(), 0)
  assert.equal(recorder.sent.length, 1)
  const verification = recorder.sent[0]!
  assert.equal(verification.kind, 'verification')
  assert.equal(verification.email, email)
  assert.ok(verification.token.length > 0)
  const unverified = await request('/sign-in/email', { email, password: oldPassword })
  assert.equal(unverified.status, 403)
  assert.equal((await unverified.json()).code, 'EMAIL_NOT_VERIFIED')
  assert.equal(cookies(unverified), '')
  const verified = await request(`/verify-email?token=${encodeURIComponent(verification.token)}`)
  assert.equal(verified.status, 200)
  assert.equal((await verified.json()).status, true)
  const verifiedCookie = cookies(verified)
  assert.ok(verifiedCookie.length > 0)
  const verifiedSession = await adapter(verifiedCookie).getSession()
  assert.ok(verifiedSession)
  assert.equal(verifiedSession.profile.email, email)
  assert.equal(verifiedSession.identity.provider, 'better-auth')
  assert.equal((await user()).emailVerified, true)
  assert.equal(verifiedSession.identity.subject, (await user()).id)

  async function login(password: string) {
    const response = await request('/sign-in/email', { email, password })
    assert.equal(response.status, 200)
    const cookie = cookies(response)
    assert.ok(cookie.length > 0)
    const session = await adapter(cookie).refreshSession()
    assert.equal(session?.identity.subject, verifiedSession!.identity.subject)
    return cookie
  }
  const loginCookie = await login(oldPassword)
  assert.equal(await sessionCount(), 2)
  const beforeDenied = recorder.sent.length
  for (const deniedOrigin of ['https://untrusted.example.test', null]) {
    const denied = await request(
      '/request-password-reset',
      { email, redirectTo: `${origin}/reset` },
      loginCookie,
      deniedOrigin
    )
    assert.equal(denied.status, 403)
    assert.equal(recorder.sent.length, beforeDenied)
  }
  const resetRequest = await request('/request-password-reset', {
    email,
    redirectTo: `${origin}/reset`,
  })
  assert.equal(resetRequest.status, 200)
  assert.equal((await resetRequest.json()).status, true)
  const resets = recorder.sent.filter((entry) => entry.kind === 'password-reset')
  assert.equal(resets.length, 1)
  const reset = resets[0]!
  assert.equal(reset.email, email)
  assert.ok(reset.token.length > 0)
  const resetResponse = await request('/reset-password', { newPassword, token: reset.token })
  assert.equal(resetResponse.status, 200)
  assert.equal((await resetResponse.json()).status, true)
  for (const cookie of [verifiedCookie, loginCookie]) {
    assert.equal(await adapter(cookie).refreshSession(), null)
  }
  assert.equal(await sessionCount(), 0)
  const reused = await request('/reset-password', {
    newPassword: 'unused synthetic third password',
    token: reset.token,
  })
  assert.equal(reused.status, 400)
  assert.equal((await reused.json()).code, 'INVALID_TOKEN')
  const oldLogin = await request('/sign-in/email', { email, password: oldPassword })
  assert.equal(oldLogin.status, 401)
  assert.equal((await oldLogin.json()).code, 'INVALID_EMAIL_OR_PASSWORD')
  assert.equal(cookies(oldLogin), '')

  const newCookie = await login(newPassword)
  const logout = await request('/sign-out', {}, newCookie)
  assert.equal(logout.status, 200)
  assert.equal((await logout.json()).success, true)
  assert.ok(logout.headers.getSetCookie().some((value) => /session_token=;/.test(value)))
  assert.equal(await adapter(newCookie).refreshSession(), null)
  assert.equal(await sessionCount(), 0)
  // Move only this synthetic reset's deadline; no wall-clock wait or real mail.
  const expiringRequest = await request('/request-password-reset', {
    email,
    redirectTo: `${origin}/reset`,
  })
  assert.equal(expiringRequest.status, 200)
  assert.equal((await expiringRequest.json()).status, true)
  const allResets = recorder.sent.filter((entry) => entry.kind === 'password-reset')
  assert.equal(allResets.length, 2)
  const expiredToken = allResets[1]!.token
  const expiredRows = await providerSql<
    { id: string }[]
  >`UPDATE "verification" SET "expiresAt" = now() - interval '1 minute' WHERE "identifier" = ${`reset-password:${expiredToken}`} RETURNING id`
  assert.equal(expiredRows.length, 1, 'expire only the synthetic reset record')
  const expired = await request('/reset-password', {
    newPassword: 'unused expired reset acceptance password',
    token: expiredToken,
  })
  assert.equal(expired.status, 400)
  assert.equal((await expired.json()).code, 'INVALID_TOKEN')
  assert.equal(cookies(expired), '')
  assert.equal(await sessionCount(), 0)
  // Successful login with the previous password also proves expiry changed no credential.
  const revokeCookie = await login(newPassword)
  const revokeSession = await adapter(revokeCookie).getSession()
  assert.ok(revokeSession)
  await adapter(revokeCookie).revokeSession(revokeSession.session.id)
  assert.equal(await adapter(revokeCookie).refreshSession(), null)
  assert.equal(await sessionCount(), 0)
  return {
    lifecycle: 'passed',
    verificationRequired: true,
    resetSingleUse: true,
    expiredResetRefused: true,
    sessionRevocation: true,
  } as const
}
