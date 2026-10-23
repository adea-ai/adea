// The shared grammar for retained child observations (#1173). One bounded
// grammar governs what the surface may show and what the product may
// publish, so a value the control plane owns cannot be unbounded or
// control-bearing on any path.
import { describe, expect, test } from 'bun:test'

import {
  isRetainedChildFailureCode,
  isRetainedChildRole,
  isRetainedChildTerminalState,
  retainedChildFailureCodePattern,
  retainedChildRolePattern,
  retainedChildTerminalStates,
  retainedChildUnknownRole,
} from '../src/retained-child-observation'

// The boundary pairs below were checked against the control plane's child publication schema at
// e9c1e206 (packages/contracts/src/pi-child-publication.ts): its role and failureCode chain is
// z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/). Over 62,000 generated and
// boundary inputs the two agreed on every value, so these expectations are the control plane's own.
describe('retained child role grammar', () => {
  test('accepts the bounded tokens a delegation role is named with', () => {
    for (const role of ['researcher', 'reviewer', 'research/reviewer', 'child.v2', 'a_b-c.d:e/f'])
      expect(isRetainedChildRole(role)).toBe(true)
  })

  test('accepts the full control-plane length and refuses one character more', () => {
    expect(isRetainedChildRole('a'.repeat(256))).toBe(true)
    expect(isRetainedChildRole('a'.repeat(257))).toBe(false)
  })

  test('refuses prose, control characters, a leading mark and unbounded values', () => {
    for (const role of [
      'research reviewer',
      'researcher\u202E',
      'researcher\u0000',
      'researcher\n',
      '_reviewer',
      '.reviewer',
      '-reviewer',
      '',
      'x'.repeat(257),
    ])
      expect(isRetainedChildRole(role)).toBe(false)
  })

  test('refuses a value that is not a string at all', () => {
    for (const role of [undefined, null, 7, {}, []]) expect(isRetainedChildRole(role)).toBe(false)
  })
})

describe('retained child failure code grammar', () => {
  test('accepts a canonical machine code', () => {
    for (const code of ['CHILD_RUNTIME_FAILED', 'PROVIDER_FAILED', 'timeout-2', 'a/b:c.d-e_f'])
      expect(isRetainedChildFailureCode(code)).toBe(true)
  })

  test('accepts the full control-plane length and refuses one character more', () => {
    expect(isRetainedChildFailureCode('E'.repeat(256))).toBe(true)
    expect(isRetainedChildFailureCode('E'.repeat(257))).toBe(false)
  })

  test('refuses a readable reason with spaces, control-bearing and unbounded values', () => {
    // The control plane publishes only canonical tokens: a readable reason with a space is refused,
    // so it is withheld rather than shown or copied.
    for (const code of [
      'provider failed',
      'failed\u202E',
      'failed\u0007',
      'failed\nnext',
      '_PROVIDER',
      '',
      'x'.repeat(257),
    ])
      expect(isRetainedChildFailureCode(code)).toBe(false)
  })

  test('the failure code and the role share one canonical token grammar', () => {
    expect(retainedChildFailureCodePattern.source).toBe(retainedChildRolePattern.source)
  })
})

describe('retained child terminal states', () => {
  test('names exactly the three publishable terminal states', () => {
    expect(retainedChildTerminalStates).toEqual(['completed', 'failed', 'cancelled'])
    for (const state of retainedChildTerminalStates)
      expect(isRetainedChildTerminalState(state)).toBe(true)
  })

  test('refuses a state that is not a terminal outcome', () => {
    for (const state of ['running', 'awaiting_input', 'manual_intervention', 'bogus', undefined])
      expect(isRetainedChildTerminalState(state)).toBe(false)
  })

  test('names the role shown when a retained role is not a bounded token', () => {
    expect(retainedChildUnknownRole).toBe('unknown')
    expect(isRetainedChildRole(retainedChildUnknownRole)).toBe(true)
  })
})
