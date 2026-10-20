import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'

import {
  createNeonServerAdapter,
  createBetterAuthService,
  handleNeonAuthRequest,
} from '../../src/server'
import { createRecordingAuthDelivery, type RecordedAuthDelivery } from '../../src/delivery'
import { isTransportLoss } from './better-auth-worker-local.mjs'

// Exercises the composition functions the web route calls, against a disposable
// loopback PostgreSQL 18 schema. The recording transport is a local fixture; no
// mail provider, credential, or production configuration is involved.
const databaseUrl = process.env.AUTH_POSTGRES_TEST_URL
const origin = 'https://app.example.test'
const secret = 'request-path-delivery-integration-secret-long-enough'
const email = 'verify-me@example.test'
const password = 'first password long enough'
const nextPassword = 'second password long enough'

let admin: Pool | undefined
let schema: string | undefined
let environment: Record<string, string> = {}
// Set by the signup test and read by the verification test that follows it.
let tokenFromSignup = ''

function environmentFor(schemaName: string): Record<string, string> {
  const url = new URL(databaseUrl!)
  url.searchParams.set('options', `-c search_path=${schemaName}`)
  return {
    AUTH_BASE_URL: origin,
    AUTH_DATABASE_URL: url.toString(),
    AUTH_SECRET: secret,
    AUTH_TRUSTED_ORIGINS: origin,
  }
}

function request(
  path: string,
  init: { body?: unknown; cookie?: string; method?: string; origin?: string } = {}
) {
  const headers = new Headers({ origin: init.origin ?? origin })
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.cookie) headers.set('cookie', init.cookie)
  return new Request(`${origin}/api/auth/${path}`, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers,
    method: init.method ?? 'POST',
  })
}

function sessionCookie(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0]!)
    .filter((value) => value.includes('session_token'))
    .join('; ')
}

async function waitForDelivery(
  sent: readonly RecordedAuthDelivery[],
  kind: RecordedAuthDelivery['kind']
): Promise<RecordedAuthDelivery> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = sent.findLast((entry) => entry.kind === kind)
    if (found) return found
    await Bun.sleep(20)
  }
  throw new Error(`no ${kind} message was delivered`)
}

// The local dev proxy can answer with a lost connection instead of an application
// response. The built-Worker acceptance classifies that one signature and retries it,
// so a transport event cannot fail an application assertion. Only that signature is
// classified: a 500 from the route, a success, a 404 and an empty body are all left
// alone, and nothing but the status and the body is inspected.
describe('built-Worker acceptance transport loss', () => {
  test('classifies only the local proxy transport signature', () => {
    expect(
      isTransportLoss({
        status: 500,
        text: 'Error: Network connection lost.\n    at async Object.fetch',
      })
    ).toBe(true)
    expect(isTransportLoss({ status: 500, text: 'Internal Server Error' })).toBe(false)
    expect(isTransportLoss({ status: 200, text: 'Network connection lost' })).toBe(false)
    expect(isTransportLoss({ status: 404, text: 'Network connection lost' })).toBe(false)
    expect(isTransportLoss({ status: 500, text: '' })).toBe(false)
  })
})

describe.skipIf(!databaseUrl)('request-path authentication delivery (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(databaseUrl!)
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname)) {
      throw new Error('AUTH_POSTGRES_TEST_URL must use a loopback host and a disposable database')
    }
    schema = `auth_request_${crypto.randomUUID().replaceAll('-', '')}`
    admin = new Pool({ connectionString: databaseUrl, max: 1 })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    environment = environmentFor(schema)

    // Create the Better Auth tables the same way the existing PostgreSQL test does.
    const service = createBetterAuthService(environment, createRecordingAuthDelivery().delivery)
    try {
      const options = (service.auth as unknown as { options: Parameters<typeof getMigrations>[0] })
        .options
      const migrations = await getMigrations(options)
      await migrations.runMigrations()
    } finally {
      await service.close()
    }
  }, 60_000)

  afterAll(async () => {
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin?.end()
    admin = undefined
  }, 30_000)

  test('verification-required signup delivers one verification message and issues no session', async () => {
    const recorder = createRecordingAuthDelivery()
    const response = await handleNeonAuthRequest(
      'POST',
      request('sign-up/email', { body: { email, name: 'Verify Me', password } }),
      'sign-up/email',
      environment,
      { delivery: recorder.delivery }
    )
    const verification = await waitForDelivery(recorder.sent, 'verification')
    tokenFromSignup = verification.token

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(sessionCookie(response)).toBe('')
    expect(verification.email).toBe(email)
    expect(verification.url.startsWith(`${origin}/api/auth/verify-email`)).toBe(true)
    expect(recorder.sent.filter((entry) => entry.kind === 'verification')).toHaveLength(1)

    // Unverified sign-in is refused, with no session issued.
    const blocked = await handleNeonAuthRequest(
      'POST',
      request('sign-in/email', { body: { email, password } }),
      'sign-in/email',
      environment,
      { delivery: recorder.delivery }
    )
    expect(blocked.status).not.toBe(200)
    expect(sessionCookie(blocked)).toBe('')
  }, 60_000)

  test('verification with the delivered token signs in, and sign-in then works', async () => {
    const recorder = createRecordingAuthDelivery()
    const verification = await handleNeonAuthRequest(
      'GET',
      request(`verify-email?token=${encodeURIComponent(tokenFromSignup)}&callbackURL=%2F`, {
        method: 'GET',
      }),
      'verify-email',
      environment,
      { delivery: recorder.delivery }
    )
    expect(verification.headers.get('cache-control')).toBe('no-store')
    expect(sessionCookie(verification)).not.toBe('')

    const signIn = await handleNeonAuthRequest(
      'POST',
      request('sign-in/email', { body: { email, password } }),
      'sign-in/email',
      environment,
      { delivery: recorder.delivery }
    )
    expect(signIn.status).toBe(200)
    expect(sessionCookie(signIn)).not.toBe('')
  }, 60_000)

  test('password reset delivers one message, the token resets once, and the old password stops working', async () => {
    const recorder = createRecordingAuthDelivery()
    const requested = await handleNeonAuthRequest(
      'POST',
      request('request-password-reset', { body: { email, redirectTo: `${origin}/reset` } }),
      'request-password-reset',
      environment,
      { delivery: recorder.delivery }
    )
    expect(requested.headers.get('cache-control')).toBe('no-store')
    const reset = await waitForDelivery(recorder.sent, 'password-reset')
    expect(reset.email).toBe(email)

    const applied = await handleNeonAuthRequest(
      'POST',
      request('reset-password', { body: { newPassword: nextPassword, token: reset.token } }),
      'reset-password',
      environment,
      { delivery: recorder.delivery }
    )
    expect(applied.status).toBe(200)

    const replay = await handleNeonAuthRequest(
      'POST',
      request('reset-password', {
        body: { newPassword: 'third password long enough', token: reset.token },
      }),
      'reset-password',
      environment,
      { delivery: recorder.delivery }
    )
    expect(replay.status).not.toBe(200)

    const stale = await handleNeonAuthRequest(
      'POST',
      request('sign-in/email', { body: { email, password } }),
      'sign-in/email',
      environment,
      { delivery: recorder.delivery }
    )
    expect(stale.status).not.toBe(200)
  }, 60_000)

  test('an expired reset token is refused and leaves the password unchanged', async () => {
    const recorder = createRecordingAuthDelivery()
    await handleNeonAuthRequest(
      'POST',
      request('request-password-reset', { body: { email, redirectTo: `${origin}/reset` } }),
      'request-password-reset',
      environment,
      { delivery: recorder.delivery }
    )
    const reset = await waitForDelivery(recorder.sent, 'password-reset')
    await admin!.query(
      `UPDATE "${schema}"."verification" SET "expiresAt" = now() - interval '1 minute' WHERE identifier LIKE $1`,
      [`%${reset.token}%`]
    )

    const expired = await handleNeonAuthRequest(
      'POST',
      request('reset-password', {
        body: { newPassword: 'expired attempt password', token: reset.token },
      }),
      'reset-password',
      environment,
      { delivery: recorder.delivery }
    )
    expect(expired.status).not.toBe(200)
    expect(sessionCookie(expired)).toBe('')

    const current = await handleNeonAuthRequest(
      'POST',
      request('sign-in/email', { body: { email, password: nextPassword } }),
      'sign-in/email',
      environment,
      { delivery: recorder.delivery }
    )
    expect(current.status).toBe(200)
  }, 60_000)

  test('without an injected transport the request path fails closed and issues no session', async () => {
    const response = await handleNeonAuthRequest(
      'POST',
      request('request-password-reset', { body: { email, redirectTo: `${origin}/reset` } }),
      'request-password-reset',
      environment
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(sessionCookie(response)).toBe('')
    // Better Auth answers reset requests generically, so a refused transport does
    // not change the status. It runs the send in the background, the default throws
    // there, and no deliverable token reaches anyone, so no reset can complete.
    expect(response.status).toBe(200)
  }, 60_000)

  test('a hostile origin is refused before the handler and the response is still no-store', async () => {
    const recorder = createRecordingAuthDelivery()
    const response = await handleNeonAuthRequest(
      'POST',
      request('request-password-reset', {
        body: { email, redirectTo: `${origin}/reset` },
        origin: 'https://evil.example.test',
      }),
      'request-password-reset',
      environment,
      { delivery: recorder.delivery }
    )
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(recorder.sent).toEqual([])
  }, 30_000)

  test('the adapter composition registers exactly one request-owned cleanup that closes its connection', async () => {
    const cleanups: Array<() => Promise<void>> = []
    createNeonServerAdapter(
      () => ({
        getCookies: () => '',
        getHeader: () => null,
        getOrigin: () => origin,
        setCookie: () => undefined,
      }),
      environment,
      {
        delivery: createRecordingAuthDelivery().delivery,
        registerCleanup: (close) => cleanups.push(close),
      }
    )
    expect(cleanups).toHaveLength(1)
    await cleanups[0]!()
  }, 30_000)
})
