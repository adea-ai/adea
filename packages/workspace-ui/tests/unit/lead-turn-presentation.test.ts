import { expect, test } from 'bun:test'
import type { ApiLeadTurnStatus } from '@adea-ai/api-client'
import { leadTurnPresentation } from '../../src/lead-turn-presentation'

const observed = (patch: Partial<ApiLeadTurnStatus> = {}): ApiLeadTurnStatus => ({
  schemaVersion: 'adea-lead-turn/v1',
  intentId: 'intent',
  messageId: 'message',
  state: 'running',
  availability: 'available',
  ...patch,
})

test('unavailable reads preserve a last report without presenting setup or a new action', () => {
  const value = leadTurnPresentation(
    observed({ availability: 'unavailable', reasonCode: 'RUNTIME_UNAVAILABLE' }),
    true
  )
  expect(value.label).toBe('Last reported: Running')
  expect(value.notice?.kind).toBe('read')
  expect(value.notice?.text).toContain('does not confirm')
})
test('withheld answer publication preserves completed execution as a separate fact', () => {
  const value = leadTurnPresentation(
    observed({
      state: 'completed',
      availability: 'unavailable',
      reasonCode: 'PUBLICATION_WITHHELD',
    }),
    true
  )
  expect(value.label).toBe('Completed')
  expect(value.notice?.kind).toBe('publication')
  expect(value.notice?.text).toContain('without starting another model call')
})
test('setup, preparation expiry and truthful cancellation have distinct labels', () => {
  expect(leadTurnPresentation(null, false).label).toBe('Workspace lead')
  expect(
    leadTurnPresentation(observed({ state: 'blocked', availability: 'unavailable' }), false).notice
      ?.kind
  ).toBe('setup')
  expect(leadTurnPresentation(observed({ state: 'prepared' }), false).label).toBe(
    'Preparation expired'
  )
  expect(leadTurnPresentation(observed({ state: 'cancelling' }), true).label).toBe(
    'Cancellation requested'
  )
  expect(
    leadTurnPresentation(observed({ state: 'completed', publishedMessageId: 'published' }), true)
      .notice
  ).toBeNull()
})
