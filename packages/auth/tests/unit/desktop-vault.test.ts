import { describe, expect, test } from 'bun:test'

import {
  createDesktopAuthorizationAttempt,
  decodeDesktopAuthorizationAttempt,
  decodeDesktopSession,
  decodeTemporaryWorkspaceCredential,
  encodeDesktopAuthorizationAttempt,
  encodeDesktopSession,
  encodeTemporaryWorkspaceCredential,
  consumeDesktopAuthorizationCallback,
} from '../../src/desktop'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const TEMPORARY = `adea_tmp_${'b'.repeat(43)}`

const SESSION = {
  credential: 'a'.repeat(43),
  expiresAt: '2030-01-01T00:00:00.000Z',
  sessionId: SESSION_ID,
} as const

async function validAttempt() {
  return createDesktopAuthorizationAttempt({ now: 1_000 })
}

function callbackUrl(attempt: Awaited<ReturnType<typeof createDesktopAuthorizationAttempt>>) {
  const url = new URL('adea://auth/callback')
  url.searchParams.set('code', 'one-time-code')
  url.searchParams.set('nonce', attempt.nonce)
  url.searchParams.set('state', attempt.state)
  return url.toString()
}

describe('desktop vault validators: pending authorization attempt', () => {
  test('round-trips a valid attempt through encode/decode', async () => {
    const attempt = await validAttempt()
    const decoded = decodeDesktopAuthorizationAttempt(attempt)
    expect(decoded).toEqual(attempt)
    expect(
      decodeDesktopAuthorizationAttempt(JSON.parse(encodeDesktopAuthorizationAttempt(attempt)))
    ).toEqual(attempt)
  })

  test('decoded attempts remain mutable for callback consumption and still reject reuse', async () => {
    const attempt = await validAttempt()
    const decoded = decodeDesktopAuthorizationAttempt(
      JSON.parse(encodeDesktopAuthorizationAttempt(attempt))
    )
    expect(decoded).not.toBeNull()
    if (!decoded) throw new Error('valid authorization attempt did not decode')

    expect(consumeDesktopAuthorizationCallback(decoded, callbackUrl(decoded), 1_001)).toEqual({
      code: 'one-time-code',
      codeVerifier: decoded.codeVerifier,
      nonce: decoded.nonce,
      redirectUri: 'adea://auth/callback',
    })
    expect(decoded.used).toBe(true)
    expect(() => consumeDesktopAuthorizationCallback(decoded, callbackUrl(decoded), 1_002)).toThrow(
      'already consumed'
    )
  })

  test('treats malformed attempts as absent on read and refuses them on write', () => {
    const base = {
      codeChallenge: 'a'.repeat(43),
      codeVerifier: 'b'.repeat(64),
      expiresAt: 1234567890,
      nonce: 'c'.repeat(43),
      redirectUri: 'adea://auth/callback',
      state: 'd'.repeat(43),
      used: false,
    }
    expect(decodeDesktopAuthorizationAttempt(base)).toEqual(base)

    for (const malformed of [
      null,
      {},
      { ...base, codeVerifier: 'short' },
      { ...base, codeChallenge: 'a'.repeat(129) },
      { ...base, nonce: 'c'.repeat(15) },
      { ...base, state: 'd'.repeat(513) },
      { ...base, redirectUri: 'adea://auth/other' },
      { ...base, redirectUri: 'https://evil.example/callback' },
      { ...base, expiresAt: 0 },
      { ...base, expiresAt: Number.NaN },
      { ...base, expiresAt: '1234567890' },
      { ...base, used: true },
    ]) {
      expect(decodeDesktopAuthorizationAttempt(malformed)).toBeNull()
      expect(() => encodeDesktopAuthorizationAttempt(malformed)).toThrow()
    }
  })
})

describe('desktop vault validators: user session', () => {
  test('round-trips a valid session through encode/decode', () => {
    expect(decodeDesktopSession(SESSION)).toEqual(SESSION)
    expect(decodeDesktopSession(JSON.parse(encodeDesktopSession(SESSION)))).toEqual(SESSION)
  })

  test('retains the runtime UUID session-id rule', () => {
    // The spec table's looser "16–128, no whitespace" prose is deliberately not
    // adopted: a non-UUID session id stays invalid.
    expect(decodeDesktopSession({ ...SESSION, sessionId: 'x'.repeat(20) })).toBeNull()
    expect(
      decodeDesktopSession({ ...SESSION, sessionId: '11111111-1111-1111-1111-111111111111' })
    ).toBeNull()
  })

  test('treats malformed sessions as absent on read and refuses them on write', () => {
    for (const malformed of [
      null,
      {},
      { ...SESSION, credential: 'short' },
      { ...SESSION, credential: 'a'.repeat(513) },
      { ...SESSION, credential: `${'a'.repeat(31)}!` },
      { ...SESSION, sessionId: 42 },
      { ...SESSION, expiresAt: 'not-a-date' },
      { ...SESSION, expiresAt: undefined },
    ]) {
      expect(decodeDesktopSession(malformed)).toBeNull()
      expect(() => encodeDesktopSession(malformed)).toThrow()
    }
  })
})

describe('desktop vault validators: temporary workspace credential', () => {
  test('accepts the exact prefix and length only', () => {
    expect(decodeTemporaryWorkspaceCredential(TEMPORARY)).toBe(TEMPORARY)
    expect(encodeTemporaryWorkspaceCredential(TEMPORARY)).toBe(TEMPORARY)

    for (const malformed of [
      null,
      42,
      '',
      'adea_tmp_',
      `adea_tmp_${'b'.repeat(42)}`,
      `adea_tmp_${'b'.repeat(44)}`,
      `adea_tmp_${'b'.repeat(42)}!`,
      `other_tmp_${'b'.repeat(43)}`,
    ]) {
      expect(decodeTemporaryWorkspaceCredential(malformed)).toBeNull()
      expect(() => encodeTemporaryWorkspaceCredential(malformed)).toThrow()
    }
  })
})
