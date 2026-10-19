// The receipt of a focused acceptance journey.
//
// The dedicated lane runs the focused journey and must be able to tell a real
// run from a result that executed no journey at all. A pass count alone cannot
// do that, because the offline regressions of the focused file always run and
// would be counted. The journey prints its own receipt, and the lane requires
// it, so a zero-journey result is rejected instead of accepted.

/** The prefix the focused journey prints its receipt with. */
export const JOURNEY_RECEIPT_PREFIX = 'DESKTOP_PRINCIPAL_JOURNEY '

/** The receipt the focused journey printed, or null when it printed none. */
export function parseJourneyReceipt(output) {
  const line = String(output ?? '')
    .split('\n')
    .findLast((value) => value.startsWith(JOURNEY_RECEIPT_PREFIX))
  if (!line) return null
  try {
    const parsed = JSON.parse(line.slice(JOURNEY_RECEIPT_PREFIX.length))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The number of skipped tests the run reported. */
export function countSkippedTests(output) {
  const match = /\b(\d+)\s+skip\b/.exec(String(output ?? ''))
  return match ? Number(match[1]) : 0
}

/**
 * Requires the focused journey to have executed: nothing was skipped, and the
 * journey printed a receipt that says it passed.
 *
 * Throws when the journey did not run, when it was skipped, or when its receipt
 * is missing or does not say it passed.
 */
export function assertFocusedJourneyPassed(output) {
  const skipped = countSkippedTests(output)
  if (skipped > 0) {
    throw new Error(`the focused acceptance journey skipped ${skipped} test(s)`)
  }
  const receipt = parseJourneyReceipt(output)
  if (!receipt) {
    throw new Error('the focused acceptance journey produced no receipt')
  }
  if (receipt.status !== 'passed') {
    throw new Error('the focused acceptance journey did not pass')
  }
  return receipt
}
