// Projection-mapping logic from the desktop runtime bridge, tested without a
// DOM. These are the decisions that used to be buried inside a Solid component,
// where a wrong answer renders as "everything looks fine" and a test cannot see
// it: `packages/dev-view/tests` contains no `.tsx` test at all.
import { describe, expect, test } from 'bun:test'

import { CANONICAL_SESSION_STATES, canonicalSessionState } from '../src/lib/desktop-dev-runtime'

describe('session state projection', () => {
  // Every lifecycle `RuntimeSession` can carry must survive the projection. It
  // used to collapse to `active`/`ready`, so a session whose run had FAILED was
  // announced and coloured "ready" — while the projection type explicitly
  // promised those states were "not coerced into active/ready".
  test('carries every canonical lifecycle through unchanged', () => {
    for (const state of CANONICAL_SESSION_STATES) expect(canonicalSessionState(state)).toBe(state)
  })

  test('never coerces a terminal or errored lifecycle into ready', () => {
    // These five are exactly what the old ternary destroyed.
    for (const state of ['preparing', 'disconnected', 'completed', 'failed', 'cancelled'])
      expect(canonicalSessionState(state)).not.toBe('ready')
  })

  test('falls back to ready only for a lifecycle it does not recognise', () => {
    // A future register value must not be passed through into a union the type
    // does not allow, and must not blank the row either.
    for (const unknown of ['', 'READY', 'exploded', 'active ', 7, null, undefined, {}])
      expect(canonicalSessionState(unknown)).toBe('ready')
  })

  test('is case sensitive, because the register is', () => {
    expect(canonicalSessionState('active')).toBe('active')
    expect(canonicalSessionState('Active')).toBe('ready')
    expect(canonicalSessionState('FAILED')).toBe('ready')
  })
})
