import { describe, expect, test } from 'bun:test'
import { adeaFeedbackUrl } from '../src/lib/feedback'

describe('adeaFeedbackUrl', () => {
  test('builds the prefilled GitHub feedback form for the desktop lane', () => {
    const url = new URL(adeaFeedbackUrl('0.74.8', 'desktop'))
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/adea-ai/adea/issues/new')
    expect(url.searchParams.get('template')).toBe('feedback.yml')
    const context = url.searchParams.get('context') ?? ''
    expect(context).toContain('App: Adea')
    expect(context).toContain('Version: 0.74.8')
    expect(context).toContain('Platform: desktop')
  })

  test('covers the web lane and falls back when the version is unknown', () => {
    const url = new URL(adeaFeedbackUrl(undefined, 'web'))
    expect(url.searchParams.get('template')).toBe('feedback.yml')
    const context = url.searchParams.get('context') ?? ''
    expect(context).toContain('App: Adea')
    expect(context).toContain('Version: unavailable')
    expect(context).toContain('Platform: web')
  })
})
