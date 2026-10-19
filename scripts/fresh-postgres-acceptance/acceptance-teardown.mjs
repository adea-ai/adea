// The cleanup of the resources a fresh-account acceptance run owns.
//
// Every step is attempted, even when an earlier one failed, so a failed
// connection close cannot strand the resources that come after it. The
// failures are aggregated and thrown by the caller, so a run that could not
// clean up after itself fails instead of reporting a pass.

/**
 * Attempts every cleanup step and returns the failures.
 *
 * The steps run in the order they are given. A step that throws does not stop
 * the ones after it.
 */
export async function runCleanupSteps(steps) {
  const errors = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

/**
 * Fails the run when the cleanup left something behind.
 *
 * The failures are aggregated with the failure of the body when both happened,
 * so a cleanup that failed is never hidden by a body that failed, and a
 * cleanup that failed never passes.
 */
export function throwCleanupFailures(errors, context, bodyError) {
  if (errors.length === 0 && bodyError === undefined) return
  const all = bodyError === undefined ? errors : [bodyError, ...errors]
  throw new AggregateError(all, context, bodyError === undefined ? undefined : { cause: bodyError })
}
