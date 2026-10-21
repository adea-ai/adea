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

describe('retained child role grammar', () => {
  test('accepts the bounded tokens a delegation role is named with', () => {
    for (const role of ['researcher', 'reviewer', 'research/reviewer', 'child.v2', 'a_b-c.d:e/f'])
      expect(isRetainedChildRole(role)).toBe(true)
  })

  test('refuses prose, control characters and unbounded values', () => {
    for (const role of [
      'research reviewer',
      'researcher\u202E',
      'researcher\u0000',
      'researcher\n',
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
  test('accepts a machine code and a readable reason', () => {
    for (const code of ['CHILD_RUNTIME_FAILED', 'PROVIDER_FAILED', 'provider failed', 'timeout-2'])
      expect(isRetainedChildFailureCode(code)).toBe(true)
  })

  test('refuses control-bearing and unbounded values', () => {
    for (const code of ['failed\u202E', 'failed\u0007', 'failed\nnext', '', 'x'.repeat(129)])
      expect(isRetainedChildFailureCode(code)).toBe(false)
  })

  test('a failure code grammar is its own, not the role grammar', () => {
    // A code may contain a space where a role may not: the two are different
    // vocabularies, and reusing one for the other is what made a readable
    // failure code unpublishable.
    expect(retainedChildFailureCodePattern.test('provider failed')).toBe(true)
    expect(retainedChildRolePattern.test('provider failed')).toBe(false)
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
