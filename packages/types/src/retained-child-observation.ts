/**
 * Shared grammar for retained child observations that Adea displays and
 * publishes (#1173).
 *
 * The control plane owns these strings. Its published schema types a child's
 * `role` and a terminal `failureCode` as free strings, but Adea shows a role
 * to a person and copies both into a canonical timeline record. One bounded
 * grammar therefore governs every path: a value the surface may show is a
 * value the product may publish, and nothing unbounded or control-bearing
 * reaches a screen or a receipt.
 *
 * The rule is deliberately narrow. A role names the delegation's job, so it is
 * a token. A failure code names why a child failed, so it is bounded plain
 * text. Both stay inside printable ASCII: no format or control characters, so
 * a retained value can never reorder or hide the surface that reports it.
 */

/** A child role names the delegation's job. It is a bounded token, never prose. */
export const retainedChildRolePattern = /^[A-Za-z0-9._:/-]{1,256}$/

/**
 * A failure code names why a child failed. It is bounded plain text: a code
 * may contain spaces, because a control plane may report a readable reason,
 * but it may not carry control characters or run away in length.
 */
export const retainedChildFailureCodePattern = /^[-A-Za-z0-9._:/ ]{1,128}$/

/** The terminal states a retained child may report, and the only ones publishable. */
export const retainedChildTerminalStates = ['completed', 'failed', 'cancelled'] as const

export type RetainedChildTerminalState = (typeof retainedChildTerminalStates)[number]

/**
 * The role shown when a retained role is not a bounded token. A control-plane
 * value the product cannot show as a role must not be rendered as one.
 */
export const retainedChildUnknownRole = 'unknown'

export function isRetainedChildRole(value: unknown): value is string {
  return typeof value === 'string' && retainedChildRolePattern.test(value)
}

export function isRetainedChildFailureCode(value: unknown): value is string {
  return typeof value === 'string' && retainedChildFailureCodePattern.test(value)
}

export function isRetainedChildTerminalState(value: unknown): value is RetainedChildTerminalState {
  return (
    typeof value === 'string' && (retainedChildTerminalStates as readonly string[]).includes(value)
  )
}
