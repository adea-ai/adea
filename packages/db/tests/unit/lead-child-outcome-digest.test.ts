// The receipt digest of one published child outcome (#1173). The receipt
// table stores only this digest, so two deliveries of the same outcome must
// hash the same however their evidence objects were constructed, and a
// changed outcome must hash differently.
import { describe, expect, test } from 'bun:test'

import { leadChildOutcomeDigest } from '../../src/lead-child-outcome-digest'

const binding = {
  schemaVersion: 'pi-lead-dispatch/v1',
  intentId: 'f643a115-617d-4bae-8d52-cfe458c0b8ac',
  dispatchId: `dispatch_${'a'.repeat(32)}`,
  executionId: `exe_${'1'.repeat(26)}`,
  attemptId: `att_${'1'.repeat(26)}`,
  runtimeSessionId: `ses_${'1'.repeat(26)}`,
}

const evidence = {
  delegationId: `dlg_${'1'.repeat(26)}`,
  childExecutionId: `exe_${'1'.repeat(26)}`,
  childAttemptId: `att_${'1'.repeat(26)}`,
  role: 'researcher',
  state: 'completed',
  resultRef: `art_${'1'.repeat(26)}`,
  conclusion: 'The requested answer is 42.',
  publication: 'published',
}

describe('child outcome digest', () => {
  test('is independent of the property order of the evidence', () => {
    const reordered = {
      publication: 'published',
      conclusion: 'The requested answer is 42.',
      resultRef: `art_${'1'.repeat(26)}`,
      state: 'completed',
      role: 'researcher',
      childAttemptId: `att_${'1'.repeat(26)}`,
      childExecutionId: `exe_${'1'.repeat(26)}`,
      delegationId: `dlg_${'1'.repeat(26)}`,
    }
    expect(leadChildOutcomeDigest(binding, reordered)).toBe(
      leadChildOutcomeDigest(binding, evidence)
    )
  })

  test('is independent of the property order of the binding', () => {
    const reordered = {
      runtimeSessionId: binding.runtimeSessionId,
      attemptId: binding.attemptId,
      executionId: binding.executionId,
      dispatchId: binding.dispatchId,
      intentId: binding.intentId,
      schemaVersion: binding.schemaVersion,
    }
    expect(leadChildOutcomeDigest(reordered, evidence)).toBe(
      leadChildOutcomeDigest(binding, evidence)
    )
  })

  test('changes when the outcome, the attempt or the parent binding changes', () => {
    const digest = leadChildOutcomeDigest(binding, evidence)
    expect(
      leadChildOutcomeDigest(binding, { ...evidence, conclusion: 'A changed answer.' })
    ).not.toBe(digest)
    expect(
      leadChildOutcomeDigest(binding, { ...evidence, childAttemptId: `att_${'2'.repeat(26)}` })
    ).not.toBe(digest)
    expect(
      leadChildOutcomeDigest({ ...binding, attemptId: `att_${'2'.repeat(26)}` }, evidence)
    ).not.toBe(digest)
  })

  test('treats an absent optional key and an explicitly absent key as one outcome', () => {
    const withoutConclusion = { ...evidence } as Record<string, unknown>
    delete withoutConclusion.conclusion
    expect(leadChildOutcomeDigest(binding, withoutConclusion)).toBe(
      leadChildOutcomeDigest(binding, { ...evidence, conclusion: undefined })
    )
  })

  test('is a lowercase sha256 hex digest', () => {
    expect(leadChildOutcomeDigest(binding, evidence)).toMatch(/^[a-f0-9]{64}$/)
  })
})
