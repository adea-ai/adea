import { describe, expect, test } from 'bun:test'

import {
  desktopCorsHeaders,
  parseDesktopAuthorizationRequest,
  parseDesktopExchangeRequest,
  parseDesktopSessionRequest,
} from '../../src/desktop-http-server'

const trustedOrigins = ['tauri://localhost', 'http://tauri.localhost']

describe('desktop HTTP boundary', () => {
  test('accepts one exact authorization request', () => {
    const url = new URL('https://agent-hq.example/api/auth/desktop/authorize')
    url.searchParams.set('client', 'desktop')
    url.searchParams.set('code_challenge', 'c'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('nonce', 'n'.repeat(32))
    url.searchParams.set('redirect_uri', 'agent-hq://auth/callback')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', 's'.repeat(32))

    expect(parseDesktopAuthorizationRequest(new Request(url))).toEqual({
      codeChallenge: 'c'.repeat(43),
      nonce: 'n'.repeat(32),
      redirectUri: 'agent-hq://auth/callback',
      state: 's'.repeat(32),
    })
    url.searchParams.append('state', 'attacker')
    expect(() => parseDesktopAuthorizationRequest(new Request(url))).toThrow('invalid')
  })

  test('requires a trusted packaged-app origin and bounded exchange body', async () => {
    const body = {
      code: 'one-time-code',
      codeVerifier: 'v'.repeat(64),
      nonce: 'n'.repeat(32),
      redirectUri: 'agent-hq://auth/callback',
    }
    const request = new Request('https://agent-hq.example/api/auth/desktop/exchange', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin: 'tauri://localhost' },
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

  test('reads the opaque credential and session ID from headers only', () => {
    const request = new Request('https://agent-hq.example/api/auth/desktop/refresh', {
      headers: {
        authorization: `Desktop ${'x'.repeat(43)}`,
        origin: 'http://tauri.localhost',
        'x-agent-hq-desktop-session': '018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1',
      },
      method: 'POST',
    })
    expect(parseDesktopSessionRequest(request, trustedOrigins)).toMatchObject({
      credential: 'x'.repeat(43),
      sessionId: '018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1',
    })
  })

  test('never reflects an untrusted origin in CORS headers', () => {
    expect(desktopCorsHeaders('tauri://localhost', trustedOrigins)).toMatchObject({
      'access-control-allow-origin': 'tauri://localhost',
    })
    expect(desktopCorsHeaders('https://evil.example', trustedOrigins)).not.toHaveProperty(
      'access-control-allow-origin'
    )
  })
})
