// Bounded, redacted requests for the default-refusal scenario, which the harness drives
// itself rather than through the lifecycle driver. A request has an absolute deadline and
// follows the run's abort signal. It settles once, and every request and response it opens
// is destroyed on settle, so the harness's cleanup is never blocked by it. Response text is
// read only to build the redacted evidence from describeResponse. It never reaches an
// error message, and no cookie value does either.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomUUID } from 'node:crypto'
import { describeResponse } from '../../../packages/auth/tests/integration/response-evidence.mjs'
import { BoundedError } from './miniflare-bounds.mjs'

const MAX_BODY_BYTES = 64 * 1024

export function postJson(url, { body, origin, ca, signal, deadlineMs = 10_000 }) {
  const target = new URL(url)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  const payload = JSON.stringify(body)
  return new Promise((ok, fail) => {
    let settled = false
    let timer
    let request
    let response
    const onAbort = () => finish(fail, signal.reason ?? new BoundedError('request was aborted'))
    // Releases the timer, the abort listener and both sockets, then settles once.
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      response?.destroy()
      request?.destroy()
      settle(value)
    }
    if (signal?.aborted) return onAbort()
    timer = setTimeout(
      () =>
        finish(
          fail,
          new BoundedError(`request to ${target.pathname} did not finish within ${deadlineMs} ms`)
        ),
      deadlineMs
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    request = send(
      target,
      {
        method: 'POST',
        ca,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          origin,
        },
      },
      (incoming) => {
        response = incoming
        const chunks = []
        let size = 0
        incoming.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES)
            return finish(
              fail,
              new BoundedError(`response from ${target.pathname} exceeds the limit`)
            )
          chunks.push(chunk)
        })
        incoming.once('aborted', () =>
          finish(fail, new BoundedError(`response from ${target.pathname} was cut short`))
        )
        incoming.once('error', (error) => finish(fail, error))
        incoming.once('end', () =>
          finish(ok, {
            status: incoming.statusCode,
            headers: incoming.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        )
        incoming.once('close', () => {
          if (!incoming.complete)
            finish(fail, new BoundedError(`connection to ${target.pathname} closed early`))
        })
      }
    )
    request.once('error', (error) => finish(fail, error))
    request.end(payload)
  })
}

// Session cookies carrying a non-empty token. Only whether one was issued leaves here.
export function issuedSessionCookie(headers) {
  return [headers['set-cookie'] ?? []].flat().some((cookie) => /session_token=[^;]+/.test(cookie))
}

// The application default on the production output: verification required and no
// transport. Signup must issue no session, and an unverified sign-in must be refused with
// no session. Both requests carry the loopback origin, so the origin gate runs as well.
// Assertion messages carry the redacted evidence only, never a body or a cookie value.
export async function refuseUnverifiedDefault({ base, ca, signal, deadlineMs }) {
  const email = `default-refusal-${randomUUID()}@example.test`
  const password = `Local-D-${randomUUID()}!`
  const signup = await postJson(new URL('/api/auth/sign-up/email', base), {
    body: { name: 'Default Refusal', email, password },
    origin: base,
    ca,
    signal,
    deadlineMs,
  })
  if (signup.status !== 200)
    throw new Error(
      `default signup returned an unexpected status: ${JSON.stringify(describeResponse(signup))}`
    )
  if (issuedSessionCookie(signup.headers))
    throw new Error('a default-verification signup must not issue a session')

  const refused = await postJson(new URL('/api/auth/sign-in/email', base), {
    body: { email, password },
    origin: base,
    ca,
    signal,
    deadlineMs,
  })
  if (refused.status !== 403)
    throw new Error(
      `unverified sign-in must be refused: ${JSON.stringify(describeResponse(refused))}`
    )
  if (issuedSessionCookie(refused.headers))
    throw new Error('a refused unverified sign-in must not issue a session')

  return {
    signupStatus: signup.status,
    signupSession: 'none',
    unverifiedSignInStatus: refused.status,
    unverifiedSignInSession: 'none',
  }
}
