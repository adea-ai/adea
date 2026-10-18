import { describe, expect, test } from 'bun:test'

import {
  createStartRequestContext,
  serializeSessionCookie,
  type CookieOptions,
  type SameSite,
  type StartCookieOptions,
} from '../../src/start'

function captureWrites() {
  const writes: Array<{ name: string; value: string; options: StartCookieOptions }> = []
  return {
    writes,
    helpers: {
      getRequest: () => new Request('https://auth.adea.dev/api/auth'),
      setCookie: (name: string, value: string, options: StartCookieOptions) => {
        writes.push({ name, value, options })
      },
    },
  }
}

describe('TanStack Start request context', () => {
  test('normalizes an uppercase sameSite before the framework writer', () => {
    const { helpers, writes } = captureWrites()
    createStartRequestContext(helpers).setCookie('session', 'abc', {
      sameSite: 'Lax',
      secure: true,
      path: '/',
    })
    expect(writes).toEqual([
      { name: 'session', value: 'abc', options: { path: '/', sameSite: 'lax', secure: true } },
    ])
  })

  test('passes a lowercase sameSite through unchanged', () => {
    const { helpers, writes } = captureWrites()
    createStartRequestContext(helpers).setCookie('session', 'abc', { sameSite: 'strict' })
    expect(writes[0]?.options).toEqual({ sameSite: 'strict' })
  })

  test('normalizes every accepted sameSite spelling to lowercase', () => {
    const spellings: Array<[CookieOptions['sameSite'], SameSite | undefined]> = [
      ['lax', 'lax'],
      ['Lax', 'lax'],
      ['none', 'none'],
      ['None', 'none'],
      ['strict', 'strict'],
      ['Strict', 'strict'],
      [undefined, undefined],
    ]
    for (const [input, expected] of spellings) {
      const { helpers, writes } = captureWrites()
      createStartRequestContext(helpers).setCookie('session', 'abc', { sameSite: input })
      expect(writes[0]?.options).toEqual(expected === undefined ? {} : { sameSite: expected })
    }
  })
})

describe('serializeSessionCookie', () => {
  test('serializes uppercase and lowercase sameSite identically', () => {
    const cases: Array<[CookieOptions['sameSite'], boolean, string]> = [
      ['lax', false, 'session=abc; SameSite=Lax'],
      ['Lax', false, 'session=abc; SameSite=Lax'],
      ['none', true, 'session=abc; Secure; SameSite=None'],
      ['None', true, 'session=abc; Secure; SameSite=None'],
      ['strict', false, 'session=abc; SameSite=Strict'],
      ['Strict', false, 'session=abc; SameSite=Strict'],
    ]
    for (const [sameSite, secure, expected] of cases) {
      expect(serializeSessionCookie('session', 'abc', { sameSite, secure })).toBe(expected)
    }
  })

  test('omits SameSite when it is absent', () => {
    expect(serializeSessionCookie('session', 'abc', { secure: true })).toBe('session=abc; Secure')
  })
})
