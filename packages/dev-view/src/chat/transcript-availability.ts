export const CHAT_RESPONSE_UNAVAILABLE_REASON =
  'Runtime response controls are unavailable because this host has no authorized response operation.'

/**
 * Chat only makes an inline response actionable when the host supplies an
 * authorized, generation-bound operation. A rendered event is not proof that
 * the current host can safely resolve it, so the absence of the callback is a
 * visible disabled state instead of a silent no-op.
 */
export function chatTranscriptActionDisabledReason(
  kind: 'approval' | 'question',
  handler: unknown
): string | undefined {
  if (typeof handler === 'function') return undefined
  return `${kind === 'approval' ? 'Approval' : 'Question'} response unavailable: ${CHAT_RESPONSE_UNAVAILABLE_REASON}`
}
