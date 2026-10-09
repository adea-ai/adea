// Direct-session handoff controls (#1177): the four distinct handoff states
// over one preserved RuntimeSession/transcript/harness/execution location,
// with truthful separate lead/job/descendant cancellation.
//
// The surface owns no authority: every control reflects the pure
// `deriveDirectSessionHandoff` view. Job and descendant cancellation stay
// disabled with the missing Control Plane J2/J4 contract named (see
// docs/plans/m14-1177-handoff-boundary.md), never silently mapped onto the
// bound harness control. All copy uses shared primitives so keyboard, focus,
// screen-reader, zoom, and reduced-motion behavior comes from the design
// system, not local markup.
import { Show, createUniqueId, type JSX } from 'solid-js'

import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { StatusChip, type StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { cn } from '@adea-ai/ui/lib/utils'

import type { DirectSessionHandoffView } from './model/handoff'

const MODE_TONES: Record<DirectSessionHandoffView['mode'], StatusTone> = {
  attached: 'neutral',
  one_time_review: 'info',
  coordination_handoff: 'info',
  returned_to_user: 'success',
}

export type DirectSessionHandoffControlsProps = Readonly<{
  view: DirectSessionHandoffView
  onLeadStop?: () => void | Promise<void>
  onReconnect?: () => void | Promise<void>
  onReturnToUser?: () => void | Promise<void>
}>

function ControlRow(
  props: Readonly<{
    id: string
    label: string
    available: boolean
    reason?: string
    remediation?: string
    onAction?: () => void | Promise<void>
    actionLabel: string
  }>
): JSX.Element {
  const reasonId = `${props.id}-reason`
  const hasReason = () => !props.available && props.reason !== undefined
  return (
    <div class="dev-handoff__control">
      <div class="dev-handoff__control-row">
        <span class="dev-handoff__control-label">{props.label}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!props.available || props.onAction === undefined}
          aria-describedby={hasReason() ? reasonId : undefined}
          onClick={() => props.onAction?.()}
        >
          {props.actionLabel}
        </Button>
      </div>
      <Show when={hasReason()}>
        <p id={reasonId} class="dev-handoff__reason" role="status">
          {props.reason}
          <Show when={props.remediation}>
            <span class="dev-handoff__remediation">{props.remediation}</span>
          </Show>
        </p>
      </Show>
    </div>
  )
}

export function DirectSessionHandoffControls(
  props: DirectSessionHandoffControlsProps
): JSX.Element {
  const baseId = createUniqueId()
  const noticeId = `${baseId}-notice`
  return (
    <section aria-label="Direct session handoff" class="dev-handoff">
      <div class="dev-handoff__header">
        <StatusChip label={props.view.label} tone={MODE_TONES[props.view.mode]} />
        <Badge variant="outline" title="Preserved session generation">
          gen {props.view.preserves.generation}
        </Badge>
        <Show when={props.view.awaitingApproval}>
          <Badge variant="secondary">awaiting approval</Badge>
        </Show>
      </div>
      <p class="dev-handoff__description">{props.view.description}</p>
      <p class="dev-handoff__preserved">
        One session, transcript, harness, and execution location are preserved; worktree and project
        authority are unchanged.
      </p>
      <Show when={props.view.notice}>
        <div
          id={noticeId}
          class={cn('dev-chat__notice', {
            'dev-handoff__notice--offline': props.view.reconnectRequired,
          })}
          role="alert"
        >
          <p>{props.view.notice}</p>
          <Show when={props.view.reconnectRequired && props.onReconnect}>
            <Button type="button" variant="outline" size="sm" onClick={() => props.onReconnect?.()}>
              Reconnect transcript
            </Button>
          </Show>
        </div>
      </Show>
      <div class="dev-handoff__controls">
        <ControlRow
          id={`${baseId}-lead`}
          label="Lead stop"
          available={props.view.controls.lead_stop.available}
          reason={props.view.controls.lead_stop.reason}
          remediation={props.view.controls.lead_stop.remediation}
          onAction={props.onLeadStop}
          actionLabel="Stop lead"
        />
        <ControlRow
          id={`${baseId}-job`}
          label="Job cancel"
          available={props.view.controls.job_cancel.available}
          reason={props.view.controls.job_cancel.reason}
          remediation={props.view.controls.job_cancel.remediation}
          actionLabel="Cancel job"
        />
        <ControlRow
          id={`${baseId}-descendant`}
          label="Descendant cancel"
          available={props.view.controls.descendant_cancel.available}
          reason={props.view.controls.descendant_cancel.reason}
          remediation={props.view.controls.descendant_cancel.remediation}
          actionLabel="Cancel descendants"
        />
      </div>
      <Show when={props.view.draftPreserved}>
        <p class="dev-handoff__draft" role="status">
          Unsent drafts are preserved across handoff states.
        </p>
      </Show>
      <Show when={props.view.mode === 'coordination_handoff' && props.onReturnToUser}>
        <div class="dev-handoff__return">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.onReturnToUser?.()}
          >
            Return to user
          </Button>
        </div>
      </Show>
    </section>
  )
}
