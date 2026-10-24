// The offline contract the CI lane needs from this harness.
//
// The shared workflow that runs the sibling disposable proof does not run this
// harness, and it is not this lane's workflow to change. These tests pin the
// contract a CI job would depend on, so the proposal that wires it can be
// reviewed against something executable:
//
//   - the host capabilities the qualification needs, and that it fails closed
//     without each of them;
//   - the exact source and head the receipt names, and the identity of the
//     artifact it proved;
//   - that a run that proved nothing is a failed run;
//   - that a failed receipt carries no value;
//   - the cleanup gate: the teardown's verdict, and that the receipt is
//     published only after that teardown ran.

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  assertBuiltWorkerDesktopAuthPassed,
  runBuiltWorkerDesktopAuth,
  type BuiltWorkerRequest,
  type BuiltWorkerResponse,
  type BuiltWorkerTransport,
} from './built-worker-desktop-auth'
import {
  assertLocalRuntimePrerequisites,
  publishableReceipt,
  removeOwnedMaterial,
  tearDownAfterWorker,
} from './built-worker-runtime'
import { BuiltWorkerFailure } from './built-worker-failures'

const RUNNER_SOURCE = readFileSync(
  resolve(import.meta.dir, '../built-worker-desktop-auth-cli.ts'),
  'utf8'
)

const ARTIFACT = {
  digest: 'a'.repeat(64),
  sha: 'b'.repeat(40),
  dirty: false,
  verified: true,
}

const PROVENANCE = { sha: 'c'.repeat(40), dirty: false, source: 'feat/railway-lane' }

/** One response, with the headers the qualification reads. */
function response(
  status: number,
  headers: Record<string, string>,
  body: string
): BuiltWorkerResponse {
  return { status, headers: { 'cache-control': 'no-store', ...headers }, body }
}

/**
 * A transport that answers like the built Worker does.
 *
 * It refuses what the product refuses: a code that was never issued or was
 * already exchanged, a wrong verifier, and an origin the exchange does not
 * trust. A fake that answered every exchange with a session would let the
 * denial assertions pass without refusing anything.
 */
function correctWorker(): BuiltWorkerTransport {
  const issued = new Map<string, { readonly challenge: string; readonly nonce: string }>()
  const sessions = new Map<string, string>()
  const providerSessions = new Map<string, string>()
  const signupCookie = '__Secure-better-auth.session_token=session-token-value-0123456789abcdef'
  let account = { email: '', password: '' }
  let providerCounter = 0
  let counter = 0
  return async (request: BuiltWorkerRequest) => {
    if (request.path === '/api/auth/get-session?disableCookieCache=true') {
      const id = providerSessions.get(request.headers?.cookie ?? '')
      return response(
        200,
        {},
        id
          ? JSON.stringify({
              user: { id: 'user-1', email: account.email },
              session: {
                id,
                token: id === 'signup-session' ? 'body-token' : 'fresh-provider-login-opaque-value',
              },
            })
          : 'null'
      )
    }
    if (request.path === '/api/auth/sign-out' && request.method === 'POST') {
      providerSessions.delete(request.headers?.cookie ?? '')
      return response(
        200,
        { 'set-cookie': `${signupCookie.split('=')[0]}=; Path=/; Max-Age=0` },
        '{"success":true}'
      )
    }
    if (request.path === '/api/auth/sign-in/email' && request.method === 'POST') {
      const body = JSON.parse(request.body ?? '{}') as { email: string; password: string }
      if (body.email !== account.email || body.password !== account.password)
        return response(401, {}, '{"code":"INVALID_EMAIL_OR_PASSWORD"}')
      providerCounter += 1
      const cookie = `new_provider_cookie=login-cookie-${providerCounter}`
      providerSessions.set(cookie, `login-session-${providerCounter}`)
      return response(
        200,
        { 'set-cookie': `${cookie}; Path=/; HttpOnly` },
        '{"token":"fresh-provider-login-opaque-value"}'
      )
    }
    if (request.method === 'POST' && request.path === '/api/auth/sign-up/email') {
      account = JSON.parse(request.body ?? '{}') as { email: string; password: string }
      providerSessions.set(signupCookie, 'signup-session')
      return response(
        200,
        {
          'set-cookie':
            '__Secure-better-auth.session_token=session-token-value-0123456789abcdef; Path=/',
        },
        '{"token":"session-token-value-0123456789abcdef","user":{"id":"user-1"}}'
      )
    }
    if (request.method === 'GET' && request.path.startsWith('/api/auth/desktop/authorize')) {
      const url = new URL(request.path, 'https://desktop.invalid')
      if ([...url.searchParams.keys()].length !== 7) {
        // The route parses the request before it looks for a session, so a
        // request that carries a parameter the desktop contract does not define
        // is refused first.
        return response(400, {}, '{"error":"Invalid desktop authorization request"}')
      }
      if (!request.headers?.cookie || !providerSessions.has(request.headers.cookie)) {
        return response(303, { location: '/auth/sign-in' }, '')
      }
      const code = `code-${issued.size}-value`
      const nonce = url.searchParams.get('nonce') ?? ''
      issued.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', nonce })
      const callback = new URL('adea://auth/callback')
      callback.searchParams.set('code', code)
      callback.searchParams.set('nonce', nonce)
      callback.searchParams.set('state', url.searchParams.get('state') ?? '')
      return response(
        303,
        { location: `/auth/desktop/complete#callback=${encodeURIComponent(callback.toString())}` },
        ''
      )
    }
    if (request.method === 'OPTIONS' && request.path === '/api/auth/desktop/exchange') {
      return response(403, {}, '{"error":"Forbidden"}')
    }
    if (request.method === 'POST' && request.path === '/api/auth/desktop/exchange') {
      const body = JSON.parse(request.body ?? '{}') as {
        code: string
        codeVerifier: string
        nonce: string
      }
      if (request.headers?.origin !== 'http://127.0.0.1:4789') {
        // An origin the exchange does not trust is refused before anything is read.
        return response(400, {}, '{"error":"Desktop authorization exchange failed"}')
      }
      const record = issued.get(body.code)
      if (!record) {
        // The code was never issued, or it was already exchanged.
        return response(400, {}, '{"error":"Desktop authorization exchange failed"}')
      }
      issued.delete(body.code)
      const challenge = createHash('sha256').update(body.codeVerifier).digest('base64url')
      if (challenge !== record.challenge || body.nonce !== record.nonce) {
        return response(400, {}, '{"error":"Desktop authorization exchange failed"}')
      }
      counter += 1
      const credential = `desktop-credential-value-0123456789abcdefghij${counter}`
      const sessionId = `8f00ffaa-0000-4000-8000-${String(counter).padStart(12, '0')}`
      sessions.set(sessionId, credential)
      return response(
        200,
        { 'access-control-allow-origin': 'http://127.0.0.1:4789' },
        JSON.stringify({ credential, expiresAt: '2027-01-01T00:00:00.000Z', sessionId })
      )
    }
    if (
      request.method === 'POST' &&
      [
        '/api/auth/desktop/refresh',
        '/api/auth/desktop/logout',
        '/api/auth/desktop/revoke',
      ].includes(request.path)
    ) {
      const trusted = request.headers?.origin === 'http://127.0.0.1:4789'
      const headers: Record<string, string> = trusted
        ? { 'access-control-allow-origin': 'http://127.0.0.1:4789' }
        : {}
      const sessionId = request.headers?.['x-adea-desktop-session'] ?? ''
      const credential = request.headers?.authorization?.replace(/^Desktop /u, '')
      if (!trusted || !credential || sessions.get(sessionId) !== credential)
        return response(401, headers, '{"error":"Desktop session is unavailable"}')
      if (request.path.endsWith('/refresh')) {
        counter += 1
        const rotated = `desktop-credential-value-0123456789abcdefghij${counter}`
        sessions.set(sessionId, rotated)
        return response(
          200,
          headers,
          JSON.stringify({ credential: rotated, expiresAt: '2027-01-01T00:00:00.000Z', sessionId })
        )
      }
      sessions.delete(sessionId)
      return response(204, headers, '')
    }
    return response(404, {}, '')
  }
}

const input = (transport: BuiltWorkerTransport) => ({
  transport,
  baseUrl: 'https://127.0.0.1:8790',
  artifact: ARTIFACT,
  secrets: ['the-known-secret-value'],
  authLifecycle: { suite: 'suite', assertions: ['one'], passed: 1 },
  evidence: 'ci' as const,
  checkout: PROVENANCE,
  module: PROVENANCE,
})

describe('the CI input contract of the built-Worker qualification', () => {
  test('the host capabilities the qualification needs are all checked', () => {
    expect(() =>
      assertLocalRuntimePrerequisites({
        hasContainerRuntime: true,
        hasCertificateTool: true,
        hasLocalRuntime: true,
      })
    ).not.toThrow()
  })

  test('a host without a container runtime fails closed', () => {
    expect(() =>
      assertLocalRuntimePrerequisites({
        hasContainerRuntime: false,
        hasCertificateTool: true,
        hasLocalRuntime: true,
      })
    ).toThrow(/container-unavailable/u)
  })

  test('a host without a certificate tool fails closed', () => {
    expect(() =>
      assertLocalRuntimePrerequisites({
        hasContainerRuntime: true,
        hasCertificateTool: false,
        hasLocalRuntime: true,
      })
    ).toThrow(/instance-unavailable/u)
  })

  test('a host without the local runtime fails closed', () => {
    expect(() =>
      assertLocalRuntimePrerequisites({
        hasContainerRuntime: true,
        hasCertificateTool: true,
        hasLocalRuntime: false,
      })
    ).toThrow(/worker-start-failed/u)
  })

  test('the runner checks the capabilities before it creates a resource', () => {
    const check = RUNNER_SOURCE.indexOf('assertLocalRuntimePrerequisites({')
    const container = RUNNER_SOURCE.indexOf('createContainer({')
    expect(check).toBeGreaterThan(-1)
    expect(container).toBeGreaterThan(check)
  })
})

describe('the fake Worker of this suite', () => {
  test('it refuses what the product refuses', async () => {
    const transport = correctWorker()
    const exchange = (code: string, codeVerifier: string, nonce: string, origin: string) =>
      transport({
        method: 'POST',
        path: '/api/auth/desktop/exchange',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          code,
          codeVerifier,
          nonce,
          redirectUri: 'adea://auth/callback',
        }),
      })

    // An origin the exchange does not trust.
    const forbiddenOrigin = await exchange(
      'code-0-value',
      'a'.repeat(43),
      'n'.repeat(16),
      'https://attacker.example.test'
    )
    expect(forbiddenOrigin.status).toBe(400)

    // A code that was never issued, or that was already exchanged.
    const unknownCode = await exchange(
      'code-0-value',
      'a'.repeat(43),
      'n'.repeat(16),
      'http://127.0.0.1:4789'
    )
    expect(unknownCode.status).toBe(400)

    // A verifier that does not match the challenge the code was issued for.
    const issued = await transport({
      method: 'GET',
      path: '/api/auth/desktop/authorize?client=desktop&code_challenge=abc&code_challenge_method=S256&nonce=nnn&redirect_uri=adea%3A%2F%2Fauth%2Fcallback&response_type=code&state=sss',
      headers: {
        cookie: '__Secure-better-auth.session_token=session-token-value-0123456789abcdef',
      },
    })
    expect(issued.status).toBe(303)
    const wrongVerifier = await exchange(
      'code-0-value',
      'b'.repeat(43),
      'nnn',
      'http://127.0.0.1:4789'
    )
    expect(wrongVerifier.status).toBe(400)

    // A request that carries a parameter the desktop contract does not define.
    const undefinedParameter = await transport({
      method: 'GET',
      path: '/api/auth/desktop/authorize?client=desktop&code_challenge=abc&code_challenge_method=S256&nonce=nnn&redirect_uri=adea%3A%2F%2Fauth%2Fcallback&response_type=code&state=sss&access_token=x',
      headers: {
        cookie: '__Secure-better-auth.session_token=session-token-value-0123456789abcdef',
      },
    })
    expect(undefinedParameter.status).toBe(400)
  })
})

describe('the receipt contract of the built-Worker qualification', () => {
  test('the receipt names the source it ran and the artifact it proved', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(input(correctWorker()))
    expect(receipt.checkout.sha).toBe(PROVENANCE.sha)
    expect(receipt.module.sha).toBe(PROVENANCE.sha)
    expect(receipt.worker.artifact.digest).toBe(ARTIFACT.digest)
    expect(receipt.worker.artifact.sha).toBe(ARTIFACT.sha)
    expect(receipt.worker.artifact.verified).toBe(true)
  })

  test('a run that proved nothing is a failed run', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(
      input(async () => ({ status: 404, headers: {}, body: '' }))
    )
    // A receipt is a pass only when an assertion passed and none failed.
    expect(receipt.failed).toBeGreaterThan(0)
    expect(receipt.status).toBe('failed')
    expect(() => assertBuiltWorkerDesktopAuthPassed(receipt)).toThrow(/assertion-failed/u)
  })

  test('a receipt of a run that proved everything is a pass', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(input(correctWorker()))
    const failed = receipt.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => `${assertion.name}: ${assertion.detail}`)
    expect(receipt.passed).toBeGreaterThan(0)
    expect(failed).toEqual([])
    expect(receipt.failed).toBe(0)
    expect(receipt.status).toBe('passed')
    expect(() => assertBuiltWorkerDesktopAuthPassed(receipt)).not.toThrow()
  })

  test('a failed receipt carries no value', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(
      input(async () => ({ status: 404, headers: {}, body: '' }))
    )
    const printed = JSON.stringify(receipt)
    expect(printed).not.toContain('the-known-secret-value')
    expect(receipt.failed).toBeGreaterThan(0)
  })

  test('a passing receipt carries no value either', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(input(correctWorker()))
    const printed = JSON.stringify(receipt)
    expect(printed).not.toContain('the-known-secret-value')
    expect(printed).not.toContain('desktop-credential-value-0123456789abcdefghij')
  })
})

describe('the cleanup gate of the built-Worker qualification', () => {
  test('the teardown reports what it removed', async () => {
    const order: string[] = []
    const teardown = await tearDownAfterWorker({
      worker: {
        requestStop: () => {
          order.push('asked to stop')
        },
        stop: async () => {
          order.push('stopped')
        },
      },
      removeContainer: () => {
        order.push('container removed')
      },
      removeMaterial: () => {
        order.push('material removed')
      },
    })
    expect(teardown.workerStopped).toBe(true)
    expect(teardown.containerRemoved).toBe(true)
    expect(teardown.materialRemoved).toBe(true)
    expect(order).toEqual(['stopped', 'container removed', 'material removed'])
  })

  test('a Worker that is still alive keeps its material', () => {
    let removed = 0
    const outcome = removeOwnedMaterial({
      worker: { groupAlive: () => true, requestStop: () => undefined },
      remove: () => {
        removed += 1
      },
    })
    expect(outcome.removed).toBe(false)
    expect(removed).toBe(0)
  })

  test('the receipt is published only after the teardown ran', () => {
    const teardown = RUNNER_SOURCE.indexOf('tearDownAfterWorker({')
    const published = RUNNER_SOURCE.indexOf('BUILT_WORKER_DESKTOP_AUTH ${')
    expect(teardown).toBeGreaterThan(-1)
    expect(published).toBeGreaterThan(teardown)
  })

  test('a failed teardown publishes no receipt', () => {
    const receipt = { status: 'passed' }
    const verdict = { workerStopped: true, containerRemoved: true, materialRemoved: true }
    // The Worker is still alive, or its material is still there, or the teardown
    // itself failed: no receipt is published.
    expect(
      publishableReceipt({
        receipt,
        verdict: { ...verdict, workerStopped: false },
        cleanupFailed: false,
      })
    ).toBeNull()
    expect(
      publishableReceipt({
        receipt,
        verdict: { ...verdict, materialRemoved: false },
        cleanupFailed: false,
      })
    ).toBeNull()
    expect(publishableReceipt({ receipt, verdict, cleanupFailed: true })).toBeNull()
    const published = publishableReceipt({ receipt, verdict, cleanupFailed: false })
    expect(published?.cleanup.materialRemoved).toBe(true)
  })

  test('a cleanup failure is reported with its kind and a redacted detail', () => {
    const failure = new BuiltWorkerFailure('cleanup-failed', 'the container was not removed')
    expect(failure.kind).toBe('cleanup-failed')
    expect(failure.detail).toBe('the container was not removed')
  })
})

// Execute the real entry with a Docker executable that cannot contact a daemon.
// Non-metadata commands stop at the first availability check, before any build
// or resource creation. Its receipt proves which authority that first call saw.
function runDockerAuthorityEntry(
  environment: Readonly<Record<string, string | undefined>>,
  contextEndpoint: string
) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-worker-docker-authority-'))
  const receipt = join(directory, 'calls.jsonl')
  const docker = join(directory, 'docker')
  writeFileSync(
    docker,
    String.raw`#!${process.execPath}
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.AUTHORITY_RECEIPT, JSON.stringify({args, host:process.env.DOCKER_HOST ?? null, context:process.env.DOCKER_CONTEXT ?? null, tls:process.env.DOCKER_TLS_VERIFY ?? null, cert:process.env.DOCKER_CERT_PATH ?? null}) + '\n')
if (args[0] === 'context' && args[1] === 'inspect') {
  console.log(process.env.AUTHORITY_CONTEXT_ENDPOINT)
} else process.exitCode = 1
`,
    { mode: 0o700 }
  )
  // The entry uses an absolute Bun path; a future ordering regression must
  // still never execute a real application build from this offline fixture.
  writeFileSync(
    join(directory, 'bun'),
    String.raw`#!${process.execPath}
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.AUTHORITY_RECEIPT, JSON.stringify({ args: ['unexpected-build', ...process.argv.slice(2)] }) + '\n')
process.exitCode = 1
`,
    { mode: 0o700 }
  )
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--no-env-file',
        '--conditions=react-server',
        resolve(import.meta.dir, '../built-worker-desktop-auth-cli.ts'),
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: `${directory}${delimiter}${process.env.PATH}`,
          AUTHORITY_RECEIPT: receipt,
          AUTHORITY_CONTEXT_ENDPOINT: JSON.stringify(contextEndpoint),
          ...environment,
        },
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/container-unavailable|fresh-schema/)
    const calls = existsSync(receipt)
      ? readFileSync(receipt, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
    return { result, calls }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('built Worker CLI local Docker authority', () => {
  test.each([
    { DOCKER_HOST: 'tcp://remote.example.test:2376' },
    { DOCKER_HOST: 'ssh://operator@remote.example.test' },
    { DOCKER_TLS_VERIFY: '1' },
    { DOCKER_CERT_PATH: '/synthetic/certificates' },
  ])('rejects inherited remote or TLS authority before daemon access: %j', (environment) => {
    const { calls } = runDockerAuthorityEntry(environment, 'unix:///synthetic/docker.sock')
    expect(calls).toEqual([])
  })

  test('rejects a remote selected context before daemon access even with a local host override', () => {
    const { calls } = runDockerAuthorityEntry(
      { DOCKER_HOST: 'unix:///synthetic/docker.sock', DOCKER_CONTEXT: 'remote-context' },
      'ssh://operator@remote.example.test'
    )
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([['context', 'inspect']])
  })

  test('pins the selected local context before the first daemon call and removes competing routing', () => {
    const selected = 'unix:///synthetic/selected.sock'
    const { calls } = runDockerAuthorityEntry(
      {
        DOCKER_HOST: 'unix:///synthetic/other.sock',
        DOCKER_CONTEXT: 'selected',
        DOCKER_TLS_VERIFY: '',
        DOCKER_CERT_PATH: '',
      },
      selected
    )
    expect(calls.map((call) => call.args[0])).toEqual(['context', 'info'])
    expect(calls[1]).toMatchObject({ host: selected, context: null, tls: null, cert: null })
  })
})
