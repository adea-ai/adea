import { describe, expect, test } from 'bun:test'

import { normalizeEmail } from '../../src/normalize'

describe('normalizeEmail', () => {
  test('leaves a clean address untouched', () => {
    expect(normalizeEmail('andy@niftyleague.com')).toBe('andy@niftyleague.com')
    expect(normalizeEmail('ANDY@NiftyLeague.com')).toBe('ANDY@NiftyLeague.com')
  })

  test('strips the invisible characters that copy-paste carries', () => {
    // Each of these reached the provider as "invalid email" when the form
    // only trimmed ASCII whitespace (observed live, 2026-09-14).
    expect(normalizeEmail('andy@niftyleague.com\u00A0')).toBe('andy@niftyleague.com')
    expect(normalizeEmail('\u00A0andy@niftyleague.com')).toBe('andy@niftyleague.com')
    expect(normalizeEmail('andy@niftyleague.com\u200B')).toBe('andy@niftyleague.com')
    expect(normalizeEmail('andy\u200C@niftyleague.com')).toBe('andy@niftyleague.com')
    expect(normalizeEmail('\uFEFFandy@niftyleague.com')).toBe('andy@niftyleague.com')
    expect(normalizeEmail('andy@niftyleague.com\u3000')).toBe('andy@niftyleague.com')
    expect(normalizeEmail(' andy@niftyleague.com\t')).toBe('andy@niftyleague.com')
  })

  test('folds fullwidth and lookalike forms through NFKC', () => {
    expect(normalizeEmail('\uFF41\uFF4E\uFF44\uFF59\uFF20niftyleague.com')).toBe(
      'andy@niftyleague.com'
    )
  })
})
