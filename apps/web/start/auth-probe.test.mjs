// Regression tests for the default-refusal probe. The servers are local and short-lived,
// so no Worker, Miniflare or PostgreSQL runs here. They cover redaction, the absolute
// deadline, mid-body disconnect, interruption and the HTTPS trust path.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { postJson, refuseUnverifiedDefault } from './auth-probe.mjs'
import { createLoopbackCertificate } from './loopback-tls.mjs'
import { BoundedError } from './miniflare-bounds.mjs'

const SENTINEL = 'SENTINEL-SESSION-TOKEN-7f3a9c2e'
const servers = []

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    server.closeAllConnections()
    await new Promise((ok) => server.close(() => ok()))
  }
})

async function serve(handler, tls) {
  const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler)
  servers.push(server)
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

async function errorOf(promise) {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error) => error
  )
}

describe('redaction of token-bearing responses', () => {
  test('a failure body with a session token never reaches the assertion message', async () => {
    const base = await serve((request, response) =>
      json(response, 500, { token: SENTINEL, code: 'UNKNOWN' })
    )
    const error = await errorOf(refuseUnverifiedDefault({ base }))
    expect(error.message).toContain('unexpected status')
    expect(error.message).not.toContain(SENTINEL)
    expect(String(error.stack)).not.toContain(SENTINEL)
  })

  test('a signup that issues a session is refused, and the cookie value is not echoed', async () => {
    const base = await serve((request, response) =>
      json(
        response,
        200,
        { token: SENTINEL, user: { email: 'a@example.test' } },
        { 'set-cookie': [`better-auth.session_token=${SENTINEL}; Path=/; HttpOnly`] }
      )
    )
    const error = await errorOf(refuseUnverifiedDefault({ base }))
    expect(error.message).toBe('a default-verification signup must not issue a session')
    expect(error.message).not.toContain(SENTINEL)
  })

  test('a sign-in that is not refused is reported without its body or cookie', async () => {
    let calls = 0
    const base = await serve((request, response) => {
      calls += 1
      if (calls === 1) return json(response, 200, { user: {} })
      return json(
        response,
        200,
        { token: SENTINEL },
        { 'set-cookie': [`better-auth.session_token=${SENTINEL}; Path=/`] }
      )
    })
    const error = await errorOf(refuseUnverifiedDefault({ base }))
    expect(error.message).toContain('unverified sign-in must be refused')
    expect(error.message).not.toContain(SENTINEL)
  })

  test('the refused path returns only the fixed evidence and no session', async () => {
    let calls = 0
    const base = await serve((request, response) => {
      calls += 1
      if (calls === 1) return json(response, 200, { user: {} })
      return json(response, 403, { code: 'EMAIL_NOT_VERIFIED', token: SENTINEL })
    })
    await expect(refuseUnverifiedDefault({ base })).resolves.toEqual({
      signupStatus: 200,
      signupSession: 'none',
      unverifiedSignInStatus: 403,
      unverifiedSignInSession: 'none',
    })
  })
})

describe('bounded requests', () => {
  test('a trickling response is cut at the absolute deadline and its connection is closed', async () => {
    let closed = false
    let timer
    const base = await serve((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.on('close', () => {
        closed = true
        clearInterval(timer)
      })
      timer = setInterval(() => response.write('x'), 20)
    })
    const started = Date.now()
    const error = await errorOf(
      postJson(`${base}/api/auth/sign-up/email`, { body: {}, origin: base, deadlineMs: 300 })
    )
    expect(error).toBeInstanceOf(BoundedError)
    expect(error.message).toContain('did not finish within 300 ms')
    expect(Date.now() - started).toBeLessThan(1500)
    await delay(100)
    expect(closed).toBe(true)
  })

  test('a response that never starts is bounded by the deadline', async () => {
    const base = await serve(() => {})
    const error = await errorOf(
      postJson(`${base}/api/auth/sign-up/email`, { body: {}, origin: base, deadlineMs: 200 })
    )
    expect(error).toBeInstanceOf(BoundedError)
    expect(error.message).toContain('did not finish within 200 ms')
  })

  test('a mid-body disconnect rejects instead of hanging', async () => {
    const base = await serve((request, response) => {
      response.writeHead(200, { 'content-length': 100, 'content-type': 'application/json' })
      response.write('{"partial"')
      setTimeout(() => response.socket.destroy(), 20)
    })
    const started = Date.now()
    const error = await errorOf(
      postJson(`${base}/api/auth/sign-up/email`, { body: {}, origin: base, deadlineMs: 5000 })
    )
    expect(error).toBeDefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('an interruption rejects with the abort reason and releases the request', async () => {
    const base = await serve(() => {})
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('interrupted by SIGINT')), 50)
    const started = Date.now()
    const error = await errorOf(
      postJson(`${base}/api/auth/sign-up/email`, {
        body: {},
        origin: base,
        signal: controller.signal,
        deadlineMs: 5000,
      })
    )
    expect(error.message).toBe('interrupted by SIGINT')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('a signal aborted before the request starts rejects without waiting', async () => {
    const base = await serve(() => {})
    const controller = new AbortController()
    controller.abort(new Error('interrupted by SIGTERM'))
    const error = await errorOf(
      postJson(`${base}/api/auth/sign-up/email`, {
        body: {},
        origin: base,
        signal: controller.signal,
        deadlineMs: 5000,
      })
    )
    expect(error.message).toBe('interrupted by SIGTERM')
  })

  test('an oversized response is refused without buffering it all', async () => {
    const base = await serve((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('y'.repeat(100 * 1024))
    })
    const error = await errorOf(
      postJson(`${base}/api/auth/sign-up/email`, { body: {}, origin: base, deadlineMs: 5000 })
    )
    expect(error.message).toContain('exceeds the limit')
  })

  test('a successful response returns its status and text', async () => {
    const base = await serve((request, response) => json(response, 200, { ok: true }))
    await expect(
      postJson(`${base}/api/auth/sign-up/email`, { body: {}, origin: base, deadlineMs: 5000 })
    ).resolves.toMatchObject({ status: 200, text: '{"ok":true}' })
  })
})

describe('the HTTPS trust path', () => {
  test('a request trusts only the run certificate it is given', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'auth-probe-'))
    const tls = createLoopbackCertificate(directory)
    const key = readFileSync(tls.keyPath, 'utf8')
    const cert = readFileSync(tls.certPath, 'utf8')
    const base = await serve((request, response) => json(response, 200, { ok: true }), {
      key,
      cert,
    })
    await expect(
      postJson(`${base}/api/auth/sign-up/email`, {
        body: {},
        origin: base,
        ca: cert,
        deadlineMs: 5000,
      })
    ).resolves.toMatchObject({ status: 200 })
    // Without the run's certificate as the trust anchor the handshake must fail.
    await expect(
      postJson(`${base}/api/auth/sign-up/email`, { body: {}, origin: base, deadlineMs: 5000 })
    ).rejects.toThrow()
  })
})
