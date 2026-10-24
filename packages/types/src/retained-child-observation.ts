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
 * Both values are canonical control-plane tokens. The control plane accepts a
 * role and a failure code only as one ASCII alphanumeric character followed by
 * ASCII letters, digits and `._:/-`, at most 256 characters in all, so a
 * readable reason with a space is not a value it can publish. A value outside
 * that grammar is withheld, never shown or copied.
 */

/**
 * The control plane's token grammar, which a child role and a failure code
 * share. It is the same definition as the control plane's child publication
 * schema (`packages/contracts/src/pi-child-publication.ts` at e9c1e206): one
 * ASCII alphanumeric, then `[A-Za-z0-9._:/-]`, 256 characters at most.
 */
export const retainedChildTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/

/** A child role names the delegation's job. It is a canonical control-plane token. */
export const retainedChildRolePattern = retainedChildTokenPattern

/** A failure code names why a child failed. It is a canonical control-plane token. */
export const retainedChildFailureCodePattern = retainedChildTokenPattern

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
