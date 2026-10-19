import { describe, expect, test } from 'bun:test'

import { describeResponse } from '../integration/response-evidence.mjs'

const sentinel = 'SENTINEL-SESSION-TOKEN-7f3a9c2e'

function response(status: number, text: string, headers: Record<string, string> = {}) {
  return { status, text, headers: { 'cache-control': 'private, no-store', ...headers } }
}

describe('built-Worker failure evidence', () => {
  test('a successful body that carries a session token is never echoed', () => {
    const evidence = describeResponse(
      response(200, JSON.stringify({ token: sentinel, user: { email: 'a@example.test' } }))
    )

    expect(evidence).toEqual({
      status: 200,
      connection: 'absent',
      cacheControl: 'no-store',
      bodyCategory: 'success',
    })
    expect(JSON.stringify(evidence)).not.toContain(sentinel)
  })

  test('a mixed parallel batch with a proxy failure never prints the successful body', () => {
    const batch = [
      response(200, JSON.stringify({ token: sentinel })),
      response(500, 'Error: Network connection lost.\n    at async Object.fetch'),
    ].map(describeResponse)

    const printed = JSON.stringify(batch)
    expect(printed).not.toContain(sentinel)
    expect(batch[1]).toMatchObject({ status: 500, bodyCategory: 'error' })
  })

  test('an error body keeps only a known code from the allowlist', () => {
    expect(
      describeResponse(
        response(403, JSON.stringify({ message: 'Email not verified', code: 'EMAIL_NOT_VERIFIED' }))
      ).bodyCategory
    ).toBe('error:EMAIL_NOT_VERIFIED')

    const tokenShaped = describeResponse(
      response(401, JSON.stringify({ code: sentinel, message: sentinel }))
    )
    expect(tokenShaped.bodyCategory).toBe('error')
    expect(JSON.stringify(tokenShaped)).not.toContain(sentinel)
  })

  test('an uppercase code that is not on the allowlist is reported generically', () => {
    const unknownCode = 'SENTINEL_UNKNOWN_CODE_QZXWV'
    const evidence = describeResponse(
      response(400, JSON.stringify({ code: unknownCode, message: 'refused' }))
    )

    expect(evidence.bodyCategory).toBe('error')
    expect(JSON.stringify(evidence)).not.toContain(unknownCode)
  })

  test('connection and cache-control values are normalized, never copied', () => {
    const headerSentinel = 'SENTINEL-HEADER-VALUE-9e2f'
    const evidence = describeResponse(
      response(200, '', { connection: headerSentinel, 'cache-control': headerSentinel })
    )

    expect(evidence.connection).toBe('other')
    expect(evidence.cacheControl).toBe('other')
    expect(JSON.stringify(evidence)).not.toContain(headerSentinel)
    expect(describeResponse(response(200, '', { connection: 'Keep-Alive' })).connection).toBe(
      'keep-alive'
    )
    expect(describeResponse(response(200, '', { connection: 'close' })).connection).toBe('close')
  })

  test('an error body that is not JSON is categorised, not copied', () => {
    const evidence = describeResponse(response(500, `Error: ${sentinel} leaked`))
    expect(evidence.bodyCategory).toBe('error')
    expect(JSON.stringify(evidence)).not.toContain(sentinel)
  })

  test('an empty body and a redirect are reported as empty', () => {
    expect(describeResponse(response(302, '')).bodyCategory).toBe('empty')
  })
})
