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

  test('strips the soft hyphen and other format characters the first fix missed', () => {
    // U+00AD is a format character, not whitespace — the provider rejects it
    // and the first whitespace-only strip list let it through.
    expect(normalizeEmail('andy\u00AD@niftyleague.com')).toBe('andy@niftyleague.com')
    expect(normalizeEmail('and\u0000y@niftyleague.com')).toBe('andy@niftyleague.com')
  })

  test('repairs dot damage from sentence-boundary pastes', () => {
    // A sentence period glued to the address survives a whitespace strip and
    // the provider rejects it (live-verified) — the reported failure.
    expect(normalizeEmail('andy@niftyleague.com.')).toBe('andy@niftyleague.com')
    expect(normalizeEmail('.andy@niftyleague.com')).toBe('andy@niftyleague.com')
    expect(normalizeEmail('andy@niftyleague.com..')).toBe('andy@niftyleague.com')
    expect(normalizeEmail('first..last@example.com')).toBe('first.last@example.com')
  })

  test('folds fullwidth and lookalike forms through NFKC', () => {
    expect(normalizeEmail('\uFF41\uFF4E\uFF44\uFF59\uFF20niftyleague.com')).toBe(
      'andy@niftyleague.com'
    )
  })
})
