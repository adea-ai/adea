import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import {
  assertBuiltWorkerDesktopAuthPassed,
  DESKTOP_CALLBACK_URI,
  DESKTOP_EXCHANGE_PATH,
  HOSTILE_ORIGIN,
  readIssuedAuthorizationCode,
  runBuiltWorkerDesktopAuth,
  sessionCookieFrom,
  type BuiltWorkerRequest,
  type BuiltWorkerResponse,
  type BuiltWorkerTransport,
} from './built-worker-desktop-auth'

const AUTH_LIFECYCLE = {
  suite: 'packages/auth/tests/integration/better-auth-postgres.test.ts',
  assertions: [
    'self-hosted Better Auth service (PostgreSQL) > signs a user up',
    'self-hosted Better Auth service (PostgreSQL) > reads the session back',
    'self-hosted Better Auth service (PostgreSQL) > revokes the session',
  ],
  passed: 3,
}

const PROVENANCE = { sha: 'a'.repeat(40), dirty: false, source: 'main' }

const AUTH_SECRET = 'built-worker-auth-secret-for-the-test-only-123456'

/** One response, with the headers the qualification reads. */
function response(
  status: number,
  headers: Record<string, string>,
  body: string
): BuiltWorkerResponse {
  return { status, headers, body }
}

function callbackLocation(code: string, nonce: string, state: string): string {
  const callback = new URL(DESKTOP_CALLBACK_URI)
  callback.searchParams.set('code', code)
  callback.searchParams.set('nonce', nonce)
  callback.searchParams.set('state', state)
  return `/auth/desktop/complete#callback=${encodeURIComponent(callback.toString())}`
}

/** A transport that answers like a correct built Worker does. */
function correctWorker(): {
  readonly transport: BuiltWorkerTransport
  readonly seen: BuiltWorkerRequest[]
} {
  const seen: BuiltWorkerRequest[] = []
  const issued = new Map<string, { challenge: string; nonce: string }>()
  // Codes and credentials are unique, exactly as the random values the Worker
  // issues are: a repeated value would hide a real leak.
  let counter = 0
  const transport: BuiltWorkerTransport = async (request) => {
    seen.push(request)
    if (request.method === 'POST' && request.path === '/api/auth/sign-up/email') {
      return response(
        200,
        { 'set-cookie': '__Secure-better-auth.session_token=session-value; Path=/; HttpOnly' },
        '{"token":"body-token","user":{"id":"user-1"}}'
      )
    }
    if (request.method === 'GET' && request.path.startsWith('/api/auth/desktop/authorize')) {
      const url = new URL(request.path, 'https://desktop.invalid')
      // The route parses the request before it looks for a session, so an
      // undefined parameter is refused before the caller is sent to sign in.
      if (url.searchParams.has('access_token')) {
        return response(400, {}, '{"error":"Invalid desktop authorization request"}')
      }
      if (!request.headers?.cookie) {
        return response(
          303,
          { location: '/auth/sign-in?returnTo=%2Fapi%2Fauth%2Fdesktop%2Fauthorize' },
          ''
        )
      }
      const code = `code-${counter++}-${'x'.repeat(32)}`
      const nonce = url.searchParams.get('nonce') ?? ''
      const state = url.searchParams.get('state') ?? ''
      issued.set(code, {
        challenge: url.searchParams.get('code_challenge') ?? '',
        nonce,
      })
      return response(303, { location: callbackLocation(code, nonce, state) }, '')
    }
    if (request.method === 'OPTIONS' && request.path === DESKTOP_EXCHANGE_PATH) {
      if (request.headers?.origin === HOSTILE_ORIGIN) {
        return response(403, {}, '{"error":"Forbidden"}')
      }
      return response(204, { 'access-control-allow-origin': request.headers?.origin ?? '' }, '')
    }
    if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
      const body = JSON.parse(request.body ?? '{}') as {
        code: string
        codeVerifier: string
        nonce: string
        redirectUri: string
      }
      if (request.headers?.origin !== HOSTILE_ORIGIN && body.redirectUri === DESKTOP_CALLBACK_URI) {
        const record = issued.get(body.code)
        if (!record) {
          return response(400, {}, '{"error":"Desktop authorization exchange failed"}')
        }
        const challenge = createHash('sha256').update(body.codeVerifier).digest('base64url')
        if (record.challenge !== challenge || record.nonce !== body.nonce) {
          return response(400, {}, '{"error":"Desktop authorization exchange failed"}')
        }
        issued.delete(body.code)
        return response(
          200,
          { 'access-control-allow-origin': request.headers?.origin ?? '' },
          `{"credential":"desktop-credential-value-${counter++}","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000"}`
        )
      }
      return response(400, {}, '{"error":"Desktop authorization exchange failed"}')
    }
    return response(404, {}, '{"error":"not found"}')
  }
  return { transport, seen }
}

/** A Worker that never registers the routes. */
const missingRoutes: BuiltWorkerTransport = async () => response(404, {}, '{"error":"not found"}')

/** A Worker whose local runtime answers every request with a transport error. */
const serverError: BuiltWorkerTransport = async () =>
  response(500, {}, 'Error: Network connection lost.')

/** A transport that never reaches the Worker. */
const closedSocket: BuiltWorkerTransport = async () => {
  throw new Error('the socket closed')
}

/** A Worker that accepts every exchange instead of refusing any. */
const acceptsEverything: BuiltWorkerTransport = async (request) => {
  if (request.method === 'POST' && request.path === '/api/auth/sign-up/email') {
    return response(
      200,
      { 'set-cookie': '__Secure-better-auth.session_token=session-value; Path=/' },
      '{"token":"body-token"}'
    )
  }
  if (request.method === 'GET' && request.path.startsWith('/api/auth/desktop/authorize')) {
    const url = new URL(request.path, 'https://desktop.invalid')
    const nonce = url.searchParams.get('nonce') ?? ''
    const state = url.searchParams.get('state') ?? ''
    return response(303, { location: callbackLocation('code-1', nonce, state) }, '')
  }
  if (request.method === 'OPTIONS') {
    return response(204, {}, '')
  }
  return response(
    200,
    { 'access-control-allow-origin': request.headers?.origin ?? '' },
    '{"credential":"desktop-credential-value","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000"}'
  )
}

const baseInput = (transport: BuiltWorkerTransport) => ({
  transport,
  baseUrl: 'https://127.0.0.1:8790',
  artifact: { digest: 'a'.repeat(64), sha: PROVENANCE.sha, dirty: false, verified: true },
  secrets: [AUTH_SECRET],
  authLifecycle: AUTH_LIFECYCLE,
  evidence: 'simulated' as const,
  checkout: PROVENANCE,
  module: PROVENANCE,
})

describe('the built-Worker desktop authorization qualification', () => {
  test('a correct built Worker passes every assertion', async () => {
    const { transport } = correctWorker()
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    expect(receipt.status).toBe('passed')
    expect(receipt.failed).toBe(0)
    expect(receipt.passed).toBeGreaterThan(0)
    expect(receipt.passed).toBe(receipt.assertions.length)
    expect(receipt.proofKind).toBe('built-worker-desktop-auth')
    expect(receipt.worker.routes).toEqual([
      '/api/auth/desktop/authorize',
      '/api/auth/desktop/exchange',
    ])
  })

  test('the receipt carries the full auth lifecycle assertions', async () => {
    const { transport } = correctWorker()
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    expect(receipt.authLifecycle.assertions).toEqual(AUTH_LIFECYCLE.assertions)
    expect(receipt.authLifecycle.passed).toBe(3)
  })

  test('the receipt carries every assertion by name', async () => {
    const { transport } = correctWorker()
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const names = receipt.assertions.map((assertion) => assertion.name)
    expect(names).toContain('the-desktop-authorize-route-refuses-a-request-without-a-session')
    expect(names).toContain('the-desktop-authorize-route-refuses-an-undefined-parameter')
    expect(names).toContain('the-desktop-authorize-route-issues-an-authorization-code')
    expect(names).toContain('the-desktop-exchange-route-issues-a-session')
    expect(names).toContain('the-desktop-exchange-route-refuses-a-wrong-pkce-verifier')
    expect(names).toContain('the-desktop-exchange-route-refuses-an-untrusted-origin')
    expect(names).toContain('the-desktop-exchange-route-refuses-a-replayed-code')
    expect(names).toContain('the-desktop-exchange-preflight-refuses-an-untrusted-origin')
    expect(names).toContain('no-response-carries-a-secret')
  })

  test('a Worker that never registers the routes fails the qualification', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(missingRoutes))
    expect(receipt.status).toBe('failed')
    expect(receipt.failed).toBeGreaterThan(0)
    expect(() => assertBuiltWorkerDesktopAuthPassed(receipt)).toThrow(/assertion-failed/u)
  })

  test('a Worker that accepts every exchange fails the refusal assertions', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(acceptsEverything))
    expect(receipt.status).toBe('failed')
    expect(receipt.failed).toBeGreaterThan(0)
  })

  test('a Worker that leaks the auth secret fails the qualification', async () => {
    const { transport } = correctWorker()
    const leaking: BuiltWorkerTransport = async (request) => {
      const answered = await transport(request)
      return { ...answered, body: `${answered.body}${AUTH_SECRET}` }
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(leaking))
    expect(receipt.status).toBe('failed')
    expect(
      receipt.assertions.find((assertion) => assertion.name === 'no-response-carries-a-secret')
        ?.passed
    ).toBe(false)
  })

  test('a Worker that answers every request with a server error never passes', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(serverError))
    expect(receipt.status).toBe('failed')
    expect(receipt.failed).toBeGreaterThan(0)
  })

  test('a transport that always fails never reports a pass', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(closedSocket))
    expect(receipt.status).toBe('failed')
    expect(receipt.failed).toBeGreaterThan(0)
  })

  test('the qualification refuses to run without the auth lifecycle assertions', async () => {
    const { transport } = correctWorker()
    await expect(
      runBuiltWorkerDesktopAuth({
        ...baseInput(transport),
        authLifecycle: { suite: AUTH_LIFECYCLE.suite, assertions: [], passed: 0 },
      })
    ).rejects.toThrow(/full auth lifecycle assertions/u)
  })

  test('the receipt carries no session cookie, code or credential', async () => {
    const { transport } = correctWorker()
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const printed = JSON.stringify(receipt)
    expect(printed).not.toContain(AUTH_SECRET)
    expect(printed).not.toContain('session-value')
    expect(printed).not.toContain('desktop-credential-value')
  })
})

describe('the built-Worker desktop authorization retries', () => {
  test('a transient application failure is not retried into a pass', async () => {
    const correct = correctWorker()
    let signUps = 0
    const transport: BuiltWorkerTransport = async (request) => {
      if (request.method === 'POST' && request.path === '/api/auth/sign-up/email') {
        signUps += 1
        if (signUps === 1) {
          // An application failure: the application answered, and it is not
          // the local runtime's envelope.
          return response(500, {}, '{"error":"Internal Server Error"}')
        }
      }
      return correct.transport(request)
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const signUp = receipt.assertions.find(
      (assertion) => assertion.name === 'the-built-worker-signs-up-a-fresh-account'
    )
    expect(signUp?.passed).toBe(false)
    expect(signUp?.attempts).toBe(1)
    expect(signUp?.outcomes).toEqual(['application-failure'])
    // The application failure was not retried: the sign-up was sent once, and
    // the later answer would have turned the assertion green.
    expect(signUps).toBe(1)
    expect(receipt.status).toBe('failed')
  })

  test('an infrastructure failure on a read-only step is retried', async () => {
    const correct = correctWorker()
    let authorizeRequests = 0
    const transport: BuiltWorkerTransport = async (request) => {
      if (request.method === 'GET' && request.path.startsWith('/api/auth/desktop/authorize')) {
        authorizeRequests += 1
        if (authorizeRequests === 1) {
          // The local runtime's own envelope: the request never reached the
          // application.
          return response(500, {}, 'Error: Network connection lost.')
        }
      }
      return correct.transport(request)
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const refusal = receipt.assertions.find(
      (assertion) =>
        assertion.name === 'the-desktop-authorize-route-refuses-a-request-without-a-session'
    )
    expect(refusal?.passed).toBe(true)
    expect(refusal?.attempts).toBe(2)
    expect(refusal?.outcomes).toEqual(['infrastructure-failure', 'refused'])
  })

  test('an application failure is never retried into a pass', async () => {
    const correct = correctWorker()
    let authorizeRequests = 0
    const transport: BuiltWorkerTransport = async (request) => {
      if (request.method === 'GET' && request.path.startsWith('/api/auth/desktop/authorize')) {
        authorizeRequests += 1
        if (authorizeRequests === 1) {
          // An application failure on a read-only step: the application
          // answered, so the answer is the evidence. A later answer would
          // have turned the assertion green.
          return response(500, {}, '{"error":"Internal Server Error"}')
        }
      }
      return correct.transport(request)
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const refusal = receipt.assertions.find(
      (assertion) =>
        assertion.name === 'the-desktop-authorize-route-refuses-a-request-without-a-session'
    )
    expect(refusal?.passed).toBe(false)
    expect(refusal?.attempts).toBe(1)
    expect(refusal?.outcomes).toEqual(['application-failure'])
    // One attempt, and it failed: the application failure was not retried. The
    // later steps still send their own requests, so the count is not the
    // evidence; the attempt count is.
    expect(authorizeRequests).toBeGreaterThanOrEqual(1)
    expect(receipt.status).toBe('failed')
  })

  test('an ambiguous mutation is never replayed', async () => {
    const correct = correctWorker()
    let exchanges = 0
    const transport: BuiltWorkerTransport = async (request) => {
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        exchanges += 1
        // Only the first exchange has an unknown outcome; a later exchange
        // would answer, so a replay of the first one would have turned this
        // assertion green.
        if (exchanges === 1) {
          throw new Error('the socket closed before the answer arrived')
        }
      }
      return correct.transport(request)
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const exchange = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-exchange-route-issues-a-session'
    )
    expect(exchange?.passed).toBe(false)
    expect(exchange?.attempts).toBe(1)
    expect(exchange?.outcomes).toEqual(['transport-failure'])
    // One attempt, and it failed: the unknown outcome was not replayed, and a
    // replay would have answered and turned the assertion green.
    expect(receipt.status).toBe('failed')
  })

  test('the receipt names the artifact it proved', async () => {
    const { transport } = correctWorker()
    const receipt = await runBuiltWorkerDesktopAuth({
      ...baseInput(transport),
      artifact: { digest: 'b'.repeat(64), sha: 'c'.repeat(40), dirty: true, verified: true },
    })
    expect(receipt.worker.artifact.digest).toBe('b'.repeat(64))
    expect(receipt.worker.artifact.sha).toBe('c'.repeat(40))
    expect(receipt.worker.artifact.dirty).toBe(true)
    expect(receipt.worker.artifact.verified).toBe(true)
  })

  test('every assertion carries its attempt count and its outcomes', async () => {
    const { transport } = correctWorker()
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    for (const assertion of receipt.assertions) {
      expect(assertion.attempts).toBeGreaterThanOrEqual(1)
      expect(assertion.outcomes.length).toBe(assertion.attempts)
      expect(['passed', 'refused']).toContain(assertion.outcomes.at(-1) ?? '')
    }
  })
})

describe('the built-Worker desktop authorization helpers', () => {
  test('the issued code is read out of the completion fragment', () => {
    const location = callbackLocation('the-code', 'the-nonce', 'the-state')
    expect(readIssuedAuthorizationCode(location)).toEqual({
      code: 'the-code',
      nonce: 'the-nonce',
    })
  })

  test('a location without a callback carries no code', () => {
    expect(readIssuedAuthorizationCode('/auth/sign-in?returnTo=%2F')).toEqual({
      code: '',
      nonce: '',
    })
  })

  test('the session cookie is read without its attributes', () => {
    const cookie = sessionCookieFrom({
      status: 200,
      headers: { 'set-cookie': '__Secure-better-auth.session_token=value; Path=/; HttpOnly' },
      body: '',
    })
    expect(cookie).toBe('__Secure-better-auth.session_token=value')
  })
})
