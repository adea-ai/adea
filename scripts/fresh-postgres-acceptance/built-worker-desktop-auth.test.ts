import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import {
  assertBuiltWorkerDesktopAuthPassed,
  DESKTOP_CALLBACK_URI,
  DESKTOP_EXCHANGE_PATH,
  HOSTILE_ORIGIN,
  isInfrastructureErrorEnvelope,
  readIssuedAuthorizationCode,
  runBuiltWorkerDesktopAuth,
  sessionCookieFrom,
  type BuiltWorkerRequest,
  type BuiltWorkerResponse,
  type BuiltWorkerTransport,
} from './built-worker-desktop-auth'
import { publishedReceipt } from './built-worker-failures'

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

/**
 * The escaped forms travel on the wire as they are written.
 *
 * A single-backslash JavaScript escape is cooked before the request is sent,
 * so the wire would carry the character and not the escape. These are the
 * literal backslash sequences, and the regressions assert the wire.
 */
const ESCAPED_CREDENTIAL_KEY = String.raw`\u0063redential`
const ESCAPED_SECRET_PREFIX = String.raw`\u0062`

/** The caller's own secret, used by the credential accounting regressions. */
const CALLER_AUTH_SECRET = 'built-worker-auth-secret-for-the-test-only-123456'

/** The session the product answers with. */
function validSession(credential: string): string {
  return `{"credential":"${credential}","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000"}`
}

/** The origin the built Worker serves on. */
const WORKER_ORIGIN = 'https://127.0.0.1:8790'

/**
 * A credential the real desktop client accepts: base64url, 32 to 512
 * characters, and unique per response.
 */
function desktopCredential(counter: number): string {
  return `${'A'.repeat(40)}${counter}`
}

/**
 * The location the product route sends.
 *
 * The route answers with a relative location, the way the product sends it,
 * and the qualification must accept exactly that.
 */
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
          `{"credential":"${desktopCredential(counter++)}","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000"}`
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
    `{"credential":"${desktopCredential(0)}","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000"}`
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
    expect(printed).not.toContain('A'.repeat(40))
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

/**
 * A Worker whose authorize route answers with the given location.
 *
 * The location is built from the request, so a test can vary one part of the
 * redirect while the rest of it stays exactly what the route would send.
 */
function workerWithAuthorize(
  location: (request: URL) => string,
  status = 303
): {
  readonly transport: BuiltWorkerTransport
  readonly exchanges: () => number
} {
  const correct = correctWorker()
  let exchanges = 0
  const transport: BuiltWorkerTransport = async (request) => {
    if (request.method === 'GET' && request.path.startsWith('/api/auth/desktop/authorize')) {
      const url = new URL(request.path, 'https://desktop.invalid')
      if (url.searchParams.has('access_token') || !request.headers?.cookie) {
        return correct.transport(request)
      }
      return response(status, { location: location(url) }, '')
    }
    if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
      exchanges += 1
    }
    return correct.transport(request)
  }
  return { transport, exchanges: () => exchanges }
}

/** The callback the authorize route would send, with the client's own values. */
function validCallback(url: URL, overrides: { nonce?: string; state?: string } = {}): string {
  const callback = new URL('adea://auth/callback')
  callback.searchParams.set('code', 'abcdefghijklmnop')
  callback.searchParams.set('nonce', overrides.nonce ?? url.searchParams.get('nonce') ?? '')
  callback.searchParams.set('state', overrides.state ?? url.searchParams.get('state') ?? '')
  return encodeURIComponent(callback.toString())
}

describe('the built-Worker desktop authorization validation', () => {
  test('a relative completion location is the valid one', async () => {
    const correct = correctWorker()
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(correct.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(true)
    expect(receipt.status).toBe('passed')
  })

  test('an authorize that answers another destination issues nothing', async () => {
    const worker = workerWithAuthorize((url) => `/auth/elsewhere#callback=${validCallback(url)}`)
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    // No exchange may be sent without a validated authorization.
    expect(worker.exchanges()).toBe(0)
  })

  test('an authorize that answers another callback destination issues nothing', async () => {
    const worker = workerWithAuthorize(
      () =>
        `${WORKER_ORIGIN}/auth/desktop/complete#callback=${encodeURIComponent(
          'adea://evil/callback?code=abcdefghijklmnop&nonce=n&state=s'
        )}`
    )
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('an authorize whose callback carries another nonce issues nothing', async () => {
    const worker = workerWithAuthorize(
      (url) => `/auth/desktop/complete#callback=${validCallback(url, { nonce: 'another-nonce' })}`
    )
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('an authorize whose callback carries another state issues nothing', async () => {
    const worker = workerWithAuthorize(
      (url) => `/auth/desktop/complete#callback=${validCallback(url, { state: 'another-state' })}`
    )
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('an authorize whose callback carries no nonce issues nothing', async () => {
    const worker = workerWithAuthorize((url) => {
      const callback = new URL('adea://auth/callback')
      callback.searchParams.set('code', 'abcdefghijklmnop')
      callback.searchParams.set('state', url.searchParams.get('state') ?? '')
      return `/auth/desktop/complete#callback=${encodeURIComponent(callback.toString())}`
    })
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('an authorize that answers the same path on another origin issues nothing', async () => {
    const worker = workerWithAuthorize(
      (url) => `https://attacker.example.test/auth/desktop/complete#callback=${validCallback(url)}`
    )
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('an authorize that answers with an unexpected query issues nothing', async () => {
    const worker = workerWithAuthorize(
      (url) => `${WORKER_ORIGIN}/auth/desktop/complete?next=evil#callback=${validCallback(url)}`
    )
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('an authorize that answers with an extra fragment parameter issues nothing', async () => {
    const worker = workerWithAuthorize(
      (url) => `${WORKER_ORIGIN}/auth/desktop/complete#callback=${validCallback(url)}&extra=value`
    )
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('an authorize whose callback carries credentials issues nothing', async () => {
    const worker = workerWithAuthorize(
      () =>
        `${WORKER_ORIGIN}/auth/desktop/complete#callback=${encodeURIComponent(
          'adea://user:password@auth/callback?code=abcdefghijklmnop&nonce=n&state=s'
        )}`
    )
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('an authorize whose callback carries a fragment issues nothing', async () => {
    const worker = workerWithAuthorize(
      () =>
        `${WORKER_ORIGIN}/auth/desktop/complete#callback=${encodeURIComponent(
          'adea://auth/callback?code=abcdefghijklmnop&nonce=n&state=s#fragment'
        )}`
    )
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('an authorize that does not answer 303 issues nothing', async () => {
    const worker = workerWithAuthorize(
      (url) => `/auth/desktop/complete#callback=${validCallback(url)}`,
      200
    )
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const issued = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-authorize-route-issues-an-authorization-code'
    )
    expect(issued?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('the wrong-verifier exchange needs a validated authorization', async () => {
    const worker = workerWithAuthorize((url) => `/auth/elsewhere#callback=${validCallback(url)}`)
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const denial = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-exchange-route-refuses-a-wrong-pkce-verifier'
    )
    expect(denial?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })

  test('the hostile-origin exchange needs a validated authorization', async () => {
    const worker = workerWithAuthorize((url) => `/auth/elsewhere#callback=${validCallback(url)}`)
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    const denial = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-exchange-route-refuses-an-untrusted-origin'
    )
    expect(denial?.passed).toBe(false)
    expect(worker.exchanges()).toBe(0)
  })
})

describe('the built-Worker desktop secret checks', () => {
  test('a code that is duplicated into the same response is a leak', async () => {
    const correct = correctWorker()
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (
        request.method === 'GET' &&
        request.path.startsWith('/api/auth/desktop/authorize') &&
        request.headers?.cookie
      ) {
        const location = answered.headers.location ?? ''
        const code = new URLSearchParams(location.split('#')[1] ?? '').get('callback') ?? ''
        const issued = /code=([^&]+)/u.exec(decodeURIComponent(code))?.[1] ?? ''
        return {
          ...answered,
          body: `{"code":"${issued}"}`,
        }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
  })

  test('a cookie value that appears in another response is a leak', async () => {
    const correct = correctWorker()
    let cookieValue = ''
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === '/api/auth/sign-up/email') {
        const cookie = answered.headers['set-cookie'] ?? ''
        cookieValue = cookie.split(';')[0]?.split('=')[1] ?? ''
        return answered
      }
      if (request.method === 'GET' && request.path.startsWith('/api/auth/desktop/authorize')) {
        if (cookieValue) {
          return { ...answered, body: `{"echo":"${cookieValue}"}` }
        }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
  })

  test('the sign-up token that appears in another response is a leak', async () => {
    const correct = correctWorker()
    let token = ''
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === '/api/auth/sign-up/email') {
        token = /"token"\s*:\s*"([^"]+)"/u.exec(answered.body)?.[1] ?? ''
        return answered
      }
      if (request.method === 'GET' && request.path.startsWith('/api/auth/desktop/authorize')) {
        if (token) {
          return { ...answered, body: `{"echo":"${token}"}` }
        }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
  })

  test('no assertion detail carries a secret', async () => {
    const { transport } = correctWorker()
    const receipt = await runBuiltWorkerDesktopAuth({
      ...baseInput(transport),
      secrets: ['the-known-secret-value'],
    })
    for (const assertion of receipt.assertions) {
      expect(assertion.detail).not.toContain('the-known-secret-value')
      expect(assertion.detail).not.toContain('session-value')
      expect(assertion.detail).not.toContain('A'.repeat(40))
    }
  })
})

describe('the built-Worker desktop failure classification', () => {
  test('an application error that starts with "Error: " is not a transport envelope', () => {
    expect(isInfrastructureErrorEnvelope('Error: the application refused the request')).toBe(false)
    expect(isInfrastructureErrorEnvelope('Error: Network connection lost.')).toBe(true)
  })

  test('an application error that starts with "Error: " is not retried', async () => {
    const correct = correctWorker()
    let authorizeRequests = 0
    const transport: BuiltWorkerTransport = async (request) => {
      if (request.method === 'GET' && request.path.startsWith('/api/auth/desktop/authorize')) {
        authorizeRequests += 1
        if (authorizeRequests === 1) {
          return response(500, {}, 'Error: the application refused the request')
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
  })
})

describe('the built-Worker desktop denial credential accounting', () => {
  /**
   * The exchange requests arrive in a fixed order: the successful one, the
   * wrong-verifier one, the hostile-origin one and the replay one. A denial
   * that answers with a fresh credential is refused by the denial that carries
   * it.
   */
  const denials: readonly { readonly name: string; readonly request: number }[] = [
    { name: 'the wrong-PKCE denial', request: 2 },
    { name: 'the hostile-origin denial', request: 3 },
    { name: 'the replay denial', request: 4 },
  ]

  for (const denial of denials) {
    test(`${denial.name} that answers with a fresh credential fails closed`, async () => {
      const correct = correctWorker()
      const fresh = `${'B'.repeat(40)}${denial.request}`
      let exchanges = 0
      const transport: BuiltWorkerTransport = async (request) => {
        const answered = await correct.transport(request)
        if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
          exchanges += 1
          if (exchanges === denial.request && answered.status !== 200) {
            // The refused answer carries a credential that has not appeared
            // before, and it is not a session the client could read.
            return {
              ...answered,
              body: `{"credential":"${fresh}","error":"Desktop authorization exchange failed"}`,
            }
          }
        }
        return answered
      }
      const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
      expect(receipt.status).toBe('failed')
      const failed = receipt.assertions.filter((assertion) => !assertion.passed)
      expect(failed.length).toBeGreaterThan(0)
      const names = failed.map((assertion) => assertion.name)
      expect(names.some((name) => name.includes('exchange-route-refuses'))).toBe(true)
    })
  }
})

describe('the built-Worker desktop credential material', () => {
  test('a session whose credential is the auth secret fails the leak invariant', async () => {
    const correct = correctWorker()
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        // The credential is the caller's own secret, so it is never a legitimate
        // issuance.
        return {
          ...answered,
          body: `{"credential":"${AUTH_SECRET}","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000"}`,
        }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth({
      ...baseInput(transport),
      secrets: [CALLER_AUTH_SECRET],
    })
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
  })

  test('a known secret escaped inside an array is not lost', async () => {
    const correct = correctWorker()
    const wire: string[] = []
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        // The issuance is the one the product answers with, and the echo array
        // carries the known secret as a scalar and inside a nested array, both
        // written with a literal backslash-u sequence.
        const body = String.raw`{"credential":"${'A'.repeat(40)}0","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000","echo":["\u0062uilt-worker-auth-secret-for-the-test-only-123456",["\u0062uilt-worker-auth-secret-for-the-test-only-123456"]]}`
        // The wire is checked before the qualification reads the body, and the
        // body is a body the product could have answered with.
        expect(body).toContain('\\u0062uilt-worker-auth-secret-for-the-test-only-123456')
        expect(() => JSON.parse(body)).not.toThrow()
        wire.push(body)
        return { ...answered, body }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth({
      ...baseInput(transport),
      secrets: [CALLER_AUTH_SECRET],
    })
    expect(wire.join('\n')).toContain('\\u0062uilt-worker-auth-secret-for-the-test-only-123456')
    // The issuance itself still succeeded: the session the Worker issued is a
    // session the client can read.
    const exchange = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-exchange-route-issues-a-session'
    )
    expect(exchange?.passed).toBe(true)
    // The echo of the known secret is what failed the run.
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
    expect(receipt.status).toBe('failed')
  })

  test('a known secret escaped in a bare root string is not lost', async () => {
    const correct = correctWorker()
    const wire: string[] = []
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        // The whole body is one string, and it is the known secret.
        const body = String.raw`"\u0062uilt-worker-auth-secret-for-the-test-only-123456"`
        expect(() => JSON.parse(body)).not.toThrow()
        wire.push(body)
        return { ...answered, body }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth({
      ...baseInput(transport),
      secrets: [CALLER_AUTH_SECRET],
    })
    expect(wire.join('\n')).toContain('\\u0062uilt-worker-auth-secret-for-the-test-only-123456')
    const exchange = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-exchange-route-issues-a-session'
    )
    expect(exchange?.passed).toBe(false)
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
    expect(receipt.status).toBe('failed')
  })

  test('a nested escaped credential under an unrelated wrapper is not lost', async () => {
    const correct = correctWorker()
    const wire: string[] = []
    let exchanges = 0
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        exchanges += 1
        if (exchanges === 2 && answered.status !== 200) {
          // The wrapper is not the member that is looked for, and it carries an
          // earlier escaped credential that a later empty duplicate shadows.
          const body = String.raw`{"data":{"\u0063redential":"FRESH_VALUE","credential":""}}`
          // The wire is checked before the qualification reads the body.
          expect(body).toContain('\\u0063redential')
          expect(body).toContain('"credential":""')
          wire.push(body)
          return { ...answered, body }
        }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    expect(wire.join('\n')).toContain('\\u0063redential')
    const denial = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-exchange-route-refuses-a-wrong-pkce-verifier'
    )
    expect(denial?.passed).toBe(false)
    expect(receipt.status).toBe('failed')
  })

  test('an earlier escaped echo of a known secret is not lost when a later duplicate is safe', async () => {
    const correct = correctWorker()
    const wire: string[] = []
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        // The earlier echo carries the known secret with an escaped character;
        // the later duplicate of the same key is safe.
        const body = String.raw`{"echo":"\u0062uilt-worker-auth-secret-for-the-test-only-123456","echo":"safe"}`
        // The wire is checked before the qualification reads the body.
        expect(body).toContain('\\u0062uilt-worker-auth-secret-for-the-test-only-123456')
        expect(body).toContain('"echo":"safe"')
        wire.push(body)
        return { ...answered, body }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth({
      ...baseInput(transport),
      secrets: [CALLER_AUTH_SECRET],
    })
    expect(wire.join('\n')).toContain('\\u0062uilt-worker-auth-secret-for-the-test-only-123456')
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
    expect(receipt.status).toBe('failed')
  })

  test('an earlier escaped credential is not lost when a later duplicate is empty', async () => {
    const correct = correctWorker()
    const wire: string[] = []
    let exchanges = 0
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        exchanges += 1
        if (exchanges === 2 && answered.status !== 200) {
          // The escaped spelling of the key comes first and carries a value;
          // the later literal duplicate is empty.
          const body = String.raw`{"\u0063redential":"FRESH_VALUE","credential":""}`
          // The wire is checked before the qualification reads the body.
          expect(body).toContain('\\u0063redential')
          expect(body).toContain('"credential":""')
          wire.push(body)
          return { ...answered, body }
        }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    expect(wire.join('\n')).toContain('\\u0063redential')
    // The refusal that carried the earlier credential did not pass.
    const denial = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-exchange-route-refuses-a-wrong-pkce-verifier'
    )
    expect(denial?.passed).toBe(false)
    expect(receipt.status).toBe('failed')
  })

  test('a refusal that carries a session cookie fails closed', async () => {
    const correct = correctWorker()
    const wire: string[] = []
    let exchanges = 0
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        exchanges += 1
        if (exchanges === 2 && answered.status !== 200) {
          const refused = {
            ...answered,
            headers: {
              ...answered.headers,
              'set-cookie':
                '__Secure-better-auth.session_token=a-fresh-session-cookie; Path=/; HttpOnly',
            },
          }
          // What the transport put on the wire is what the qualification reads.
          wire.push(refused.headers['set-cookie'] ?? '')
          return refused
        }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    // The wire carried the cookie.
    expect(wire.join('\n')).toContain('a-fresh-session-cookie')
    // The rest of the path is valid: the successful exchange still passed.
    const exchange = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-exchange-route-issues-a-session'
    )
    expect(exchange?.passed).toBe(true)
    // The refusal that carried the cookie did not pass.
    const denial = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-exchange-route-refuses-a-wrong-pkce-verifier'
    )
    expect(denial?.passed).toBe(false)
    expect(receipt.status).toBe('failed')
  })

  test('an issuance body with a known secret behind an escaped character fails the leak invariant', async () => {
    const correct = correctWorker()
    const wire: string[] = []
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        const body = `{"credential":"${'A'.repeat(40)}0","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000","echo":"${ESCAPED_SECRET_PREFIX}uilt-worker-auth-secret-for-the-test-only-123456"}`
        wire.push(body)
        return { ...answered, body }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth({
      ...baseInput(transport),
      secrets: [CALLER_AUTH_SECRET],
    })
    // The wire carried the literal backslash-u sequence.
    expect(wire.join('\n')).toContain('\\u0062')
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
  })

  const denials: readonly { readonly name: string; readonly request: number }[] = [
    { name: 'a nested credential object', request: 2 },
    { name: 'a duplicate member with an empty first value', request: 2 },
    { name: 'a member behind an escaped key', request: 2 },
    { name: 'a credential in a header', request: 2 },
    { name: 'a known secret behind an escaped character', request: 2 },
  ]

  for (const denial of denials) {
    test(`a refused answer with ${denial.name} fails closed`, async () => {
      const correct = correctWorker()
      const fresh = `${'C'.repeat(40)}${denial.request}`
      const wire: string[] = []
      let exchanges = 0
      const transport: BuiltWorkerTransport = async (request) => {
        const answered = await correct.transport(request)
        if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
          exchanges += 1
          if (exchanges === denial.request && answered.status !== 200) {
            const refused = (() => {
              switch (denial.name) {
                case 'a nested credential object':
                  return {
                    ...answered,
                    body: `{"error":"Desktop authorization exchange failed","data":{"credential":"${fresh}"}}`,
                  }
                case 'a duplicate member with an empty first value':
                  return {
                    ...answered,
                    body: `{"credential":"","credential":"${fresh}","error":"Desktop authorization exchange failed"}`,
                  }
                case 'a member behind an escaped key':
                  return {
                    ...answered,
                    body: `{"${ESCAPED_CREDENTIAL_KEY}":"${fresh}","error":"Desktop authorization exchange failed"}`,
                  }
                case 'a credential in a header':
                  return {
                    ...answered,
                    headers: { ...answered.headers, authorization: `Desktop ${fresh}` },
                  }
                default:
                  return {
                    ...answered,
                    body: `{"error":"Desktop authorization exchange failed","echo":"${ESCAPED_SECRET_PREFIX}uilt-worker-auth-secret-for-the-test-only-123456"}`,
                  }
              }
            })()
            // What the transport puts on the wire is what the qualification
            // reads, so the wire is recorded and asserted.
            wire.push(refused.body)
            return refused
          }
        }
        return answered
      }
      const receipt = await runBuiltWorkerDesktopAuth({
        ...baseInput(transport),
        secrets: [CALLER_AUTH_SECRET],
      })
      // The wire carried the literal backslash-u sequence, not a cooked
      // character: the qualification saw the escaped form.
      if (denial.name === 'a member behind an escaped key') {
        expect(wire.join('\n')).toContain('\\u0063')
        expect(wire.join('\n')).not.toContain('"credential"')
      }
      if (denial.name === 'a known secret behind an escaped character') {
        expect(wire.join('\n')).toContain('\\u0062')
      }
      expect(receipt.status).toBe('failed')
      const failed = receipt.assertions.filter((assertion) => !assertion.passed)
      expect(failed.length).toBeGreaterThan(0)
    })
  }
})

describe('the built-Worker desktop session contract', () => {
  const cases: readonly { readonly name: string; readonly body: string }[] = [
    { name: 'truncated JSON', body: validSession('A'.repeat(40)).slice(0, -1) },
    { name: 'malformed JSON', body: 'not json at all' },
    { name: 'a body that is not an object', body: '"a string"' },
    { name: 'a credential that is too short', body: validSession('short') },
    { name: 'a credential that is not base64url', body: validSession('+'.repeat(40)) },
    {
      name: 'a missing session id',
      body: `{"credential":"${'A'.repeat(40)}","expiresAt":"2027-01-01T00:00:00.000Z"}`,
    },
    {
      name: 'an invalid session id',
      body: `{"credential":"${'A'.repeat(40)}","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"not-a-session"}`,
    },
    {
      name: 'an unparseable expiry',
      body: `{"credential":"${'A'.repeat(40)}","expiresAt":"never","sessionId":"8f00ffaa-0000-4000-8000-000000000000"}`,
    },
    {
      name: 'a missing expiry',
      body: `{"credential":"${'A'.repeat(40)}","sessionId":"8f00ffaa-0000-4000-8000-000000000000"}`,
    },
  ]

  for (const testCase of cases) {
    test(`an exchange that answers with ${testCase.name} fails closed`, async () => {
      const correct = correctWorker()
      const transport: BuiltWorkerTransport = async (request) => {
        const answered = await correct.transport(request)
        if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
          return { ...answered, body: testCase.body }
        }
        return answered
      }
      const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
      const exchange = receipt.assertions.find(
        (assertion) => assertion.name === 'the-desktop-exchange-route-issues-a-session'
      )
      expect(exchange?.passed).toBe(false)
      expect(receipt.status).toBe('failed')
    })
  }
})

describe('the built-Worker desktop occurrence accounting', () => {
  test('the same value in two authorized fields is not a leak', async () => {
    const correct = correctWorker()
    const shared = 'SHARED_ISSUED_VALUE'
    const transport: BuiltWorkerTransport = async (request) => {
      if (request.method === 'POST' && request.path === '/api/auth/sign-up/email') {
        // The same value is issued in the cookie header and in the body.
        return response(
          200,
          { 'set-cookie': `__Secure-better-auth.session_token=${shared}; Path=/; HttpOnly` },
          `{"token":"${shared}","user":{"id":"user-1"}}`
        )
      }
      return correct.transport(request)
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(true)
  })

  test('a code in the outer query of the location is a leak', async () => {
    const correct = correctWorker()
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (
        request.method === 'GET' &&
        request.path.startsWith('/api/auth/desktop/authorize') &&
        request.headers?.cookie
      ) {
        const location = answered.headers.location ?? ''
        const code =
          /code=([^&]+)/u.exec(decodeURIComponent(location.split('#')[1] ?? ''))?.[1] ?? ''
        // The code is copied into the query of the outer location, before the
        // fragment that legitimately carries it.
        const leaked = location.replace('#', `?code=${code}#`)
        return { ...answered, headers: { ...answered.headers, location: leaked } }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
  })

  test('a successful exchange that returns a nested credential fails closed', async () => {
    const correct = correctWorker()
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        const credential = /"credential"\s*:\s*"([^"]+)"/u.exec(answered.body)?.[1] ?? ''
        if (credential) {
          // The credential is an object that carries another credential: there
          // is no top-level scalar credential, so the Worker issued no session.
          return { ...answered, body: `{"credential":{"credential":"${credential}"}}` }
        }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const exchange = receipt.assertions.find(
      (assertion) => assertion.name === 'the-desktop-exchange-route-issues-a-session'
    )
    expect(exchange?.passed).toBe(false)
    expect(receipt.status).toBe('failed')
  })

  test('a nested copy of an issued credential is a leak', async () => {
    const correct = correctWorker()
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        const credential = /"credential"\s*:\s*"([^"]+)"/u.exec(answered.body)?.[1] ?? ''
        if (credential) {
          // The response is otherwise the one the product sends, and it carries
          // a nested copy of the credential on top.
          return {
            ...answered,
            body: `{"credential":"${credential}","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000","data":{"credential":"${credential}"}}`,
          }
        }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
  })

  test('a duplicate of an issued credential is a leak', async () => {
    const correct = correctWorker()
    const transport: BuiltWorkerTransport = async (request) => {
      const answered = await correct.transport(request)
      if (request.method === 'POST' && request.path === DESKTOP_EXCHANGE_PATH) {
        const credential = /"credential"\s*:\s*"([^"]+)"/u.exec(answered.body)?.[1] ?? ''
        if (credential) {
          // The response is otherwise the one the product sends, and it carries
          // the credential twice.
          return {
            ...answered,
            body: `{"credential":"${credential}","credential":"${credential}","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000"}`,
          }
        }
      }
      return answered
    }
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(transport))
    const leakage = receipt.assertions.find(
      (assertion) => assertion.name === 'no-response-carries-a-secret'
    )
    expect(leakage?.passed).toBe(false)
  })
})

describe('the built-Worker desktop receipt sanitization', () => {
  test('a failed location that names a token never reaches the receipt', async () => {
    const worker = workerWithAuthorize(() => '/error?token=SYNTHETIC_SECRET')
    const receipt = await runBuiltWorkerDesktopAuth(baseInput(worker.transport))
    expect(JSON.stringify(receipt)).not.toContain('SYNTHETIC_SECRET')
    for (const assertion of receipt.assertions) {
      expect(assertion.detail).not.toContain('SYNTHETIC_SECRET')
    }
  })

  test('a quoted credential diagnostic never reaches the receipt', async () => {
    const { transport } = correctWorker()
    const receipt = await runBuiltWorkerDesktopAuth({
      ...baseInput(transport),
      authLifecycle: {
        suite: 'packages/auth/tests/integration/better-auth-postgres.test.ts',
        assertions: ['{"credential":"SYNTHETIC_SECRET"}'],
        passed: 1,
      },
    })
    expect(JSON.stringify(receipt)).not.toContain('SYNTHETIC_SECRET')
  })

  test('the published receipt carries the verdict and no value', async () => {
    const { transport } = correctWorker()
    // A receipt that carries a value in a nested field: the published receipt
    // must not carry it out, whatever field it sits in.
    const receipt = await runBuiltWorkerDesktopAuth({
      ...baseInput(transport),
      authLifecycle: {
        suite: 'packages/auth/tests/integration/better-auth-postgres.test.ts',
        assertions: ['{"credential":"SYNTHETIC_SECRET"}'],
        passed: 1,
      },
    })
    const published = publishedReceipt({
      receipt,
      verdict: { workerStopped: true, containerRemoved: true, materialRemoved: true },
      secrets: ['SYNTHETIC_SECRET'],
    })
    expect(JSON.stringify(published)).not.toContain('SYNTHETIC_SECRET')
    expect(published.cleanup.workerStopped).toBe(true)
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
