/**
 * The recipients as part of a message's submission identity. The server treats a repeated idempotency key
 * with a different payload as a conflict, and a group message's mentions are its recipients, so a retry
 * keeps its key only while the recipients are exactly the ones first sent. A changed choice is a changed
 * message: it gets a new key, as an edited body does.
 */
export function recipientsSubmissionContext(agentIds: readonly string[]): string {
  return `addressed:${agentIds.join(',')}`
}
