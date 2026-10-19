import { Show, type JSX } from 'solid-js'
import { Confirmation } from '@adea-ai/ui/components/composites/confirmation'
import { Trace, TraceLine } from '@adea-ai/ui/components/ui/trace'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { approvalDetails, interactionContextDisabledReason } from './model/approval'
import type { ChatTurnOutcome } from './model/turns'
import type { ChatTranscriptItem } from './presentation'

export type ChatApprovalProps = Readonly<{
  item: ChatTranscriptItem
  /** How the runtime reported this request ended, when the canvas could pair the report with it. */
  outcome?: ChatTurnOutcome
  onResolve?: (event: RuntimeEvent, resolution: 'approved' | 'denied') => void | Promise<void>
  /** Why this host cannot answer; present exactly when `onResolve` is absent. */
  disabledReason?: string
}>

const APPROVAL_PROMPT = 'Approval is required before the runtime can continue.'
const RESPONSE_UNAVAILABLE =
  'The runtime is not accepting an answer from this window yet. Respond through the runtime.'

/** The decision time as the host reported it, in UTC so it reads the same everywhere. */
function decidedAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const time = new Date(value)
  return Number.isNaN(time.getTime())
    ? undefined
    : `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * One approval event.
 *
 * Only a `requested` event is a decision: it draws the card with Approve and
 * Deny. A later `resolved` or `expired` event is a separate event, and nothing
 * in its payload is trusted to say *which* way it was resolved or which request
 * it answers, so it is drawn as a quiet line that says only what the event kind
 * says. The card never claims an outcome the runtime has not reported, and the
 * buttons stay available on an unanswered request even if a later event exists.
 *
 * The exception is a versioned outcome the transcript model could pair with this
 * exact request (same session, generation and request ids): then the request itself
 * settles into its record, "Approved" or "Denied" or "Expired", with no buttons and
 * the time only if the host sent one. Who answered is a protocol id and is not shown.
 * A versioned request also carries the host's fact that this window cannot answer it
 * yet; it is drawn as unavailable, with the reason beside the disabled buttons.
 */
export function ChatApproval(props: ChatApprovalProps): JSX.Element {
  const item = () => props.item
  // An approval is only ever approved, denied or expired; the wire gate ties the decision to the
  // kind, so anything else is not a record this card can draw.
  const settled = () => {
    const decision = props.outcome?.decision
    return decision === 'approved' || decision === 'denied' || decision === 'expired'
      ? decision
      : undefined
  }
  const unanswerable = () => {
    const interaction = item().interaction
    return interaction?.phase === 'requested' && !interaction.responseAvailable
  }
  const title = () => (item().label !== item().kind ? item().label : 'Approval requested')
  return (
    <Show
      when={item().state === 'requested' || settled() !== undefined}
      fallback={
        <Trace>
          <TraceLine
            title={title()}
            description={item().text}
            meta={item().state === 'expired' ? 'expired' : 'resolved'}
            status={item().state === 'expired' ? 'cancelled' : undefined}
            data-entry-id={item().id}
            data-event-id={item().id}
          />
        </Trace>
      }
    >
      <Confirmation
        state={settled() ?? (unanswerable() ? 'unavailable' : 'requested')}
        resolvedAt={decidedAt(props.outcome?.decidedAt)}
        title={title()}
        description={item().requestContext ?? APPROVAL_PROMPT}
        details={approvalDetails(item().requestContext, item().requestContextIncomplete)}
        approveLabel="Approve"
        denyLabel="Deny"
        onApprove={
          props.onResolve
            ? () => {
                const event = item().event
                if (event && !interactionContextDisabledReason(item()))
                  return props.onResolve?.(event, 'approved')
              }
            : undefined
        }
        onDeny={
          props.onResolve
            ? () => {
                const event = item().event
                if (event) return props.onResolve?.(event, 'denied')
              }
            : undefined
        }
        disabledReason={
          interactionContextDisabledReason(item()) ??
          (unanswerable() ? RESPONSE_UNAVAILABLE : props.disabledReason)
        }
        data-entry-id={item().id}
        data-event-id={item().id}
      />
    </Show>
  )
}
