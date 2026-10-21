import { describe, expect, test } from 'bun:test'

import {
  desktopCorsHeaders,
  parseDesktopAuthorizationRequest,
  parseDesktopExchangeRequest,
  parseDesktopSessionRequest,
} from '../../src/desktop-http-server'

const trustedOrigins = ['http://127.0.0.1:4789', 'http://127.0.0.1:1420']
const EXCHANGE_URL = 'https://agent-hq.example/api/auth/desktop/exchange'
const MAX_EXCHANGE_BODY_BYTES = 4_096
const CHUNK = 1_024

const EXCHANGE = {
  code: 'one-time-code',
  codeVerifier: 'v'.repeat(64),
  nonce: 'n'.repeat(32),
  redirectUri: 'adea://auth/callback',
}

/**
 * A stream of CHUNK-byte pieces that counts how often it is pulled and whether it was
 * cancelled. `highWaterMark: 0` keeps the stream from pulling before a read, so the
 * count is reads only. It errors after 100 pulls, so an unbounded reader fails the
 * count assertions below rather than hanging. No large fixture is ever built.
 */
function countedStream(chunks: number) {
  const state = { cancelled: false, pulls: 0 }
  const body = new ReadableStream<Uint8Array>(
    {
      cancel() {
        state.cancelled = true
      },
      pull(controller) {
        state.pulls += 1
        if (state.pulls > 100) {
          controller.error(new Error('unbounded read'))
          return
        }
        if (state.pulls > chunks) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20))
      },
    },
    { highWaterMark: 0 }
  )
  return { body, state }
}

/**
 * The same counted stream, carrying an exact byte sequence instead of filler. The
 * bytes are delivered in `chunkSize` pieces, so the last piece may be short.
 */
function byteStream(bytes: Uint8Array, chunkSize: number) {
  const state = { cancelled: false, pulls: 0 }
  const body = new ReadableStream<Uint8Array>(
    {
      cancel() {
        state.cancelled = true
      },
      pull(controller) {
        state.pulls += 1
        if (state.pulls > 100) {
          controller.error(new Error('unbounded read'))
          return
        }
        const start = (state.pulls - 1) * chunkSize
        if (start >= bytes.byteLength) {
          controller.close()
          return
        }
        controller.enqueue(bytes.subarray(start, Math.min(start + chunkSize, bytes.byteLength)))
      },
    },
    { highWaterMark: 0 }
  )
  return { body, state }
}

/**
 * A valid exchange body of exactly `total` bytes. The four members are the only
 * members; the remaining bytes are JSON whitespace, which adds no key and leaves the
 * body admissible on every other rule.
 */
function exchangeBodyOf(total: number): Uint8Array {
  const head = `{"code":"${EXCHANGE.code}","codeVerifier":"${EXCHANGE.codeVerifier}","nonce":"${EXCHANGE.nonce}","redirectUri":"${EXCHANGE.redirectUri}"`
  const bytes = new TextEncoder().encode(`${head}${' '.repeat(total - head.length - 1)}}`)
  if (bytes.byteLength !== total) throw new Error('the padded body must be exactly `total` bytes')
  return bytes
}

function exchangeRequest(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request(EXCHANGE_URL, {
    body,
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:4789',
      ...headers,
    },
    method: 'POST',
  })
}

describe('desktop HTTP boundary', () => {
  test('accepts one exact authorization request', () => {
    const url = new URL('https://agent-hq.example/api/auth/desktop/authorize')
    url.searchParams.set('client', 'desktop')
    url.searchParams.set('code_challenge', 'c'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('nonce', 'n'.repeat(32))
    url.searchParams.set('redirect_uri', 'adea://auth/callback')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', 's'.repeat(32))

    expect(parseDesktopAuthorizationRequest(new Request(url))).toEqual({
      codeChallenge: 'c'.repeat(43),
      nonce: 'n'.repeat(32),
      redirectUri: 'adea://auth/callback',
      state: 's'.repeat(32),
    })
    url.searchParams.append('state', 'attacker')
    expect(() => parseDesktopAuthorizationRequest(new Request(url))).toThrow('invalid')
  })

  test('requires a trusted shell origin and bounded exchange body', async () => {
    const body = {
      code: 'one-time-code',
      codeVerifier: 'v'.repeat(64),
      nonce: 'n'.repeat(32),
      redirectUri: 'adea://auth/callback',
    }
    const request = new Request('https://agent-hq.example/api/auth/desktop/exchange', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4789' },
      method: 'POST',
    })
    await expect(parseDesktopExchangeRequest(request, trustedOrigins)).resolves.toEqual(body)

    const untrusted = new Request('https://agent-hq.example/api/auth/desktop/exchange', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      method: 'POST',
    })
    await expect(parseDesktopExchangeRequest(untrusted, trustedOrigins)).rejects.toThrow(
      'not trusted'
    )
  })

  test('refuses a body that is not JSON before it is read', async () => {
    const { body, state } = countedStream(1)
    const request = exchangeRequest(body, { 'content-type': 'text/plain' })
    await expect(parseDesktopExchangeRequest(request, trustedOrigins)).rejects.toThrow(
      'content type is invalid'
    )
    expect(state.pulls).toBe(0)
    expect(request.bodyUsed).toBe(false)
  })

  test('cancels an oversized stream when the Content-Length is absent', async () => {
    const { body, state } = countedStream(100)
    const request = exchangeRequest(body)
    expect(request.headers.get('content-length')).toBeNull()

    await expect(parseDesktopExchangeRequest(request, trustedOrigins)).rejects.toThrow('invalid')
    // The claim is absent, so the bytes that arrive decide admission: the stream is
    // cancelled at the chunk that crosses the limit. Four chunks fit, the fifth does
    // not. One read ahead is allowed, nothing more.
    expect(state.cancelled).toBe(true)
    expect(state.pulls).toBeLessThanOrEqual(6)
  })

  test('cancels an oversized stream when the Content-Length understates the body', async () => {
    const { body, state } = countedStream(100)
    const request = exchangeRequest(body, { 'content-length': '10' })

    await expect(parseDesktopExchangeRequest(request, trustedOrigins)).rejects.toThrow('invalid')
    // An understated claim admits nothing on its own: the same limit applies to the
    // bytes that actually arrive, and the stream is cancelled where it crosses.
    expect(state.cancelled).toBe(true)
    expect(state.pulls).toBeLessThanOrEqual(6)
  })

  test('accepts a body of exactly the limit and refuses one byte more', async () => {
    const atLimit = byteStream(exchangeBodyOf(MAX_EXCHANGE_BODY_BYTES), CHUNK)
    const accepted = exchangeRequest(atLimit.body)
    await expect(parseDesktopExchangeRequest(accepted, trustedOrigins)).resolves.toEqual(EXCHANGE)
    // The body fits, so the stream is read to its end and never cancelled.
    expect(atLimit.state.cancelled).toBe(false)

    const overLimit = byteStream(exchangeBodyOf(MAX_EXCHANGE_BODY_BYTES + 1), CHUNK)
    const refused = exchangeRequest(overLimit.body)
    await expect(parseDesktopExchangeRequest(refused, trustedOrigins)).rejects.toThrow('invalid')
    // The same admissible body, one byte longer, is refused on the byte count alone.
    expect(overLimit.state.cancelled).toBe(true)
  })

  test('refuses a declared oversized body without reading it', async () => {
    const { body, state } = countedStream(1)
    const request = exchangeRequest(body, { 'content-length': '8192' })

    await expect(parseDesktopExchangeRequest(request, trustedOrigins)).rejects.toThrow('invalid')
    // The claim alone is enough to refuse: not one byte of the body is read.
    expect(state.pulls).toBe(0)
    expect(state.cancelled).toBe(false)
    expect(request.bodyUsed).toBe(false)
  })

  test('reads the opaque credential and session ID from headers only', () => {
    const request = new Request('https://agent-hq.example/api/auth/desktop/refresh', {
      headers: {
        authorization: `Desktop ${'x'.repeat(43)}`,
        origin: 'http://127.0.0.1:1420',
        'x-adea-desktop-session': '018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1',
      },
      method: 'POST',
    })
    expect(parseDesktopSessionRequest(request, trustedOrigins)).toMatchObject({
      credential: 'x'.repeat(43),
      sessionId: '018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1',
    })
  })

  test('never reflects an untrusted origin in CORS headers', () => {
    expect(desktopCorsHeaders('http://127.0.0.1:4789', trustedOrigins)).toMatchObject({
      'access-control-allow-origin': 'http://127.0.0.1:4789',
    })
    expect(desktopCorsHeaders('https://evil.example', trustedOrigins)).not.toHaveProperty(
      'access-control-allow-origin'
    )
  })
})
