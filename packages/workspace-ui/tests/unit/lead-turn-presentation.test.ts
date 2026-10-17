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

test('a refused requested model says nothing ran and no other model was substituted', () => {
  const value = leadTurnPresentation(
    observed({
      state: 'blocked',
      availability: 'unavailable',
      reasonCode: 'REQUESTED_MODEL_MISMATCH',
    }),
    true
  )
  expect(value.notice?.kind).toBe('model')
  expect(value.notice?.text).toContain('nothing ran')
  expect(value.notice?.text).toContain('no other model was substituted')
  expect(value.notice?.text).toContain('draft are preserved')
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

test('a refused readiness check names its remedy and says nothing ran', () => {
  const cases: Record<string, string> = {
    QUOTA_EXHAUSTED: 'quota',
    CREDENTIAL_EXPIRED: 'valid credential',
    WORKSPACE_GRANT_REVOKED: 'access',
    AUTH_MODE_UNSUPPORTED: 'authentication supported',
  }
  for (const [readinessReason, expected] of Object.entries(cases)) {
    const value = leadTurnPresentation(
      observed({
        state: 'blocked',
        availability: 'unavailable',
        reasonCode: 'MODEL_NOT_READY',
        readinessReason,
      }),
      true
    )
    expect(value.notice?.kind).toBe('readiness')
    expect(value.notice?.text).toContain('Nothing ran')
    expect(value.notice?.text).toContain('no other model was substituted')
    expect(value.notice?.text).toContain(expected)
    expect(value.notice?.text).toContain('draft and lead customization are preserved')
    expect(value.notice?.text).not.toContain('Lead setup is unavailable')
  }
})

test('an unknown or missing readiness reason reads as unverifiable, never as provider text', () => {
  for (const readinessReason of [undefined, 'sk-live-provider-text', 'READY']) {
    const value = leadTurnPresentation(
      observed({
        state: 'blocked',
        availability: 'unavailable',
        reasonCode: 'MODEL_NOT_READY',
        ...(readinessReason ? { readinessReason } : {}),
      }),
      true
    )
    expect(value.notice?.text).toContain('could not be verified')
    expect(value.notice?.text).not.toContain('sk-live')
  }
})

test('a refusal after dispatch does not claim that nothing ran', () => {
  const value = leadTurnPresentation(
    observed({
      state: 'running',
      availability: 'unavailable',
      dispatchId: `dispatch_${'b'.repeat(32)}`,
      reasonCode: 'MODEL_NOT_READY',
      readinessReason: 'CREDENTIAL_REVOKED',
    }),
    true
  )
  expect(value.notice?.text).toContain('changed during this turn')
  expect(value.notice?.text).toContain('does not start another model call')
  expect(value.notice?.text).not.toContain('Nothing ran')
})

test('a held refusal applies only to an unprepared turn and never overrides a specific reason', () => {
  const blocked = observed({ state: 'blocked', availability: 'unavailable' })
  expect(leadTurnPresentation(blocked, true, 'QUOTA_EXHAUSTED').notice?.kind).toBe('readiness')
  expect(leadTurnPresentation(blocked, true, null).notice?.kind).toBe('setup')
  expect(
    leadTurnPresentation(observed({ state: 'prepared' }), true, 'QUOTA_EXHAUSTED').notice
  ).toBeNull()
  expect(
    leadTurnPresentation(
      { ...blocked, reasonCode: 'REQUESTED_MODEL_MISMATCH' },
      true,
      'QUOTA_EXHAUSTED'
    ).notice?.kind
  ).toBe('model')
})
