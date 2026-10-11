import { expect, test } from 'bun:test'

import { createFeedbackUrl } from '../src/lib/feedback-url'

test('feedback link prepopulates app context without adding diagnostics', () => {
  const url = new URL(createFeedbackUrl({ platform: 'desktop', version: '0.73.0' }))

  expect(url.origin).toBe('https://github.com')
  expect(url.pathname).toBe('/adea-ai/adea/issues/new')
  expect(url.searchParams.get('template')).toBe('feedback.yml')
  expect(url.searchParams.get('context')).toBe('Adea desktop · version 0.73.0')
  expect(url.searchParams.has('report_details')).toBe(false)
})

test('feedback link identifies the web runtime when no version is available', () => {
  const url = new URL(createFeedbackUrl({ platform: 'web' }))

  expect(url.searchParams.get('context')).toBe('Adea web')
})
