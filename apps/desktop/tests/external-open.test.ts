import { describe, expect, test } from 'bun:test'

import { isExternalOpenableUrl } from '../shell/src/commands'

describe('external link handoff', () => {
  test('opens plain credential-free web links only', () => {
    expect(
      isExternalOpenableUrl('https://github.com/adea-ai/adea/issues/new?template=feedback.yml')
    ).toBe(true)
    expect(isExternalOpenableUrl('https://github.com/adea-ai/adea')).toBe(true)
    expect(isExternalOpenableUrl('http://localhost:4097/status')).toBe(true)
    expect(isExternalOpenableUrl('https://user:secret@example.com')).toBe(false)
    expect(isExternalOpenableUrl('file:///etc/passwd')).toBe(false)
    expect(isExternalOpenableUrl('javascript:alert(1)')).toBe(false)
    expect(isExternalOpenableUrl('adea://auth/callback')).toBe(false)
    expect(isExternalOpenableUrl('not a url')).toBe(false)
    expect(isExternalOpenableUrl('')).toBe(false)
  })
})
