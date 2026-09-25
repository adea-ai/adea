/*
 * Execution-location provenance (#671). The policy layer decides where work
 * runs and records a reroute as a new attempt; this assembles what was
 * persisted into the read model a task's history answers from.
 *
 * It lives here rather than in `@adea-ai/types` because it runs on rows: the
 * types package is a type-only dependency for this package, so importing a
 * *value* from it would make the database layer need its build output.
 */
import type { ExecutionAttemptSummary, TaskExecutionLocation } from '@adea-ai/types'

/**
 * Assembles the read model from persisted attempts. Returns undefined for a
 * task with no recorded execution, so the field's absence means "has not run"
 * rather than "ran nowhere".
 *
 * A cloud attempt whose stored node survives a schema change is normalised to
 * no node here as well as in the database check: the read model must not
 * contradict the rule that only the reserved cloud location is nodeless.
 */
export function taskExecutionFromAttempts(
  attempts: readonly ExecutionAttemptSummary[]
): TaskExecutionLocation | undefined {
  if (attempts.length === 0) return undefined
  const normalized = attempts
    .map((attempt) => {
      if (attempt.locationKind !== 'agent_hq_cloud' || attempt.runtimeNodeId === undefined)
        return attempt
      const { runtimeNodeId: _dropped, ...rest } = attempt
      return rest
    })
    .toSorted((left, right) => left.attempt - right.attempt)
  const current = normalized[normalized.length - 1] as ExecutionAttemptSummary
  return Object.freeze({ attempts: Object.freeze(normalized), current })
}
