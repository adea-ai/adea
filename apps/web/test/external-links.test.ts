import { expect, test } from 'bun:test'

import { resolveAdeaExternalUrl } from '../src/lib/external-links'

test('external links are restricted to credential-free Adea GitHub resources', () => {
  expect(resolveAdeaExternalUrl('https://github.com/adea-ai/adea/issues/new')).toBe(
    'https://github.com/adea-ai/adea/issues/new'
  )
  for (const url of [
    'http://github.com/adea-ai/adea',
    'https://github.com.evil.test/adea-ai/adea',
    'https://github.com/adea-ai/adea-evil',
    'https://user@github.com/adea-ai/adea',
    'https://example.com/',
  ]) {
    expect(resolveAdeaExternalUrl(url)).toBeUndefined()
  }
})
