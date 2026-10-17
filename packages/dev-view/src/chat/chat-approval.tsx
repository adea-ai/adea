import { Show, type JSX } from 'solid-js'
import { Confirmation } from '@adea-ai/ui/components/composites/confirmation'
import { Trace, TraceLine } from '@adea-ai/ui/components/ui/trace'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { approvalDetails, interactionContextDisabledReason } from './model/approval'
import type { ChatTranscriptItem } from './presentation'

export type ChatApprovalProps = Readonly<{
  item: ChatTranscriptItem
  onResolve?: (event: RuntimeEvent, resolution: 'approved' | 'denied') => void | Promise<void>
  /** Why this host cannot answer; present exactly when `onResolve` is absent. */
  disabledReason?: string
}>

const APPROVAL_PROMPT = 'Approval is required before the runtime can continue.'

/**
 * One approval event.
 *
 * Only a `requested` event is a decision: it draws the card with Approve and
 * Deny. A later `resolved` or `expired` event is a separate event, and nothing
 * in its payload is trusted to say *which* way it was resolved or which request
 * it answers, so it is drawn as a quiet line that says only what the event kind
 * says. The card never claims an outcome the runtime has not reported, and the
 * buttons stay available on an unanswered request even if a later event exists.
 */
export function ChatApproval(props: ChatApprovalProps): JSX.Element {
  const item = () => props.item
  const title = () => (item().label !== item().kind ? item().label : 'Approval requested')
  return (
    <Show
      when={item().state === 'requested'}
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
        state="requested"
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
        disabledReason={interactionContextDisabledReason(item()) ?? props.disabledReason}
        data-entry-id={item().id}
        data-event-id={item().id}
      />
    </Show>
  )
}
