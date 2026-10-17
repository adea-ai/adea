import type { ChatTranscriptItem } from '../presentation'

/**
 * The shared Confirmation shows its description clipped to this many characters,
 * so a longer request needs the rest somewhere the reader can open.
 */
export const APPROVAL_DESCRIPTION_LIMIT = 400

/**
 * The full redacted, bounded request as inspectable details, only when the
 * description would be clipped. `text` is already redacted and bounded by the
 * projection; this never reads the raw payload.
 */
export function approvalDetails(
  text: string | undefined,
  incomplete = false
): { kind: 'code'; code: string; title: string } | undefined {
  return text !== undefined && (incomplete || text.length > APPROVAL_DESCRIPTION_LIMIT)
    ? {
        kind: 'code',
        code: text,
        title: incomplete ? 'Request preview (incomplete)' : 'Full request',
      }
    : undefined
}

/** A callback is never permission to answer a request whose context was clipped. */
export function interactionContextDisabledReason(item: ChatTranscriptItem): string | undefined {
  return item.requestContextIncomplete || !item.requestContext?.trim()
    ? 'Complete request context is unavailable within the safe display limit. Respond through the runtime.'
    : undefined
}
