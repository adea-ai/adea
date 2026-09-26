import { describe, expect, test } from 'bun:test'

import { isSameOriginRequest } from '../src/server/same-origin'

const OWN = new URL('https://hq.example/rooms')
const request = (headers: Record<string, string>) =>
  new Request('https://hq.example/rooms', { headers })

describe('same-origin admission', () => {
  test('accepts the request origin and refuses everything else by default', () => {
    expect(isSameOriginRequest(request({ origin: 'https://hq.example' }), OWN, {})).toBe(true)
    expect(isSameOriginRequest(request({ origin: 'https://evil.example' }), OWN, {})).toBe(false)
    // A path on the same origin is still the same origin.
    expect(isSameOriginRequest(request({ origin: 'https://hq.example/a/b' }), OWN, {})).toBe(true)
    // Scheme and port are part of the origin.
    expect(isSameOriginRequest(request({ origin: 'http://hq.example' }), OWN, {})).toBe(false)
    expect(isSameOriginRequest(request({ origin: 'https://hq.example:8443' }), OWN, {})).toBe(false)
    // No Origin, or a malformed one, is a refusal.
    expect(isSameOriginRequest(request({}), OWN, {})).toBe(false)
    expect(isSameOriginRequest(request({ origin: 'not a url' }), OWN, {})).toBe(false)
  })

  // The regression: an allow set rebuilt from caller-supplied headers lets a
  // cross-origin caller vouch for itself. These all presented the attacker's
  // own origin and were accepted by the header-derived version.
  test('never trusts Host or X-Forwarded-Host to vouch for a foreign origin', () => {
    const forged = {
      origin: 'https://evil.example',
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    }
    expect(isSameOriginRequest(request(forged), OWN, {})).toBe(false)

    // Also refused when the attacker splits across both headers, which is the
    // shape the old loop walked value-by-value.
    expect(
      isSameOriginRequest(
        request({ origin: 'https://evil.example', 'x-forwarded-host': 'evil.example, hq.example' }),
        OWN,
        {}
      )
    ).toBe(false)
    expect(
      isSameOriginRequest(
        request({ origin: 'https://evil.example', 'x-forwarded-proto': 'https,http' }),
        OWN,
        {}
      )
    ).toBe(false)
  })

  test('honours a CONFIGURED trusted origin, and only that one', () => {
    const env = { AUTH_TRUSTED_ORIGINS: 'https://hq.example, http://localhost:3000' }
    expect(isSameOriginRequest(request({ origin: 'http://localhost:3000' }), OWN, env)).toBe(true)
    expect(isSameOriginRequest(request({ origin: 'http://localhost:3001' }), OWN, env)).toBe(false)
    expect(isSameOriginRequest(request({ origin: 'https://evil.example' }), OWN, env)).toBe(false)
  })

  test('a malformed configured origin is ignored, never widening the set', () => {
    const env = { AUTH_TRUSTED_ORIGINS: 'https://ok.example, not-a-url' }
    expect(isSameOriginRequest(request({ origin: 'https://ok.example' }), OWN, env)).toBe(true)
    expect(isSameOriginRequest(request({ origin: 'https://not-a-url' }), OWN, env)).toBe(false)
  })
})
