// Direct-session handoff controls (#1177): the four distinct handoff states
// over one preserved RuntimeSession/transcript/harness/execution location,
// with truthful separate lead/job/descendant/return cancellation.
//
// The surface owns no authority: every control reflects the pure
// `deriveDirectSessionHandoff` view. Job and descendant cancellation stay
// disabled with the missing Control Plane J2/J4 contract named (see
// docs/plans/m14-1177-handoff-boundary.md), never silently mapped onto the
// bound harness control. Return-to-user executes the persisted
// `dev.session.transferInput` through the caller's handler and is guarded by
// the same offline/stale/conflict/scope/archived gates as lead-stop, with
// single-flight busy handling and an explicit error-and-retry state. All copy
// uses shared primitives so keyboard, focus, screen-reader, zoom, and
// reduced-motion behavior comes from the design system, not local markup.
import { For, Show, createUniqueId, type JSX } from 'solid-js'

import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { StatusChip, type StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { cn } from '@adea-ai/ui/lib/utils'

import {
  handoffControlReasonId,
  type DirectSessionHandoffView,
  type HandoffActionKind,
  type HandoffControlKind,
} from './model/handoff'

const MODE_TONES: Record<DirectSessionHandoffView['mode'], StatusTone> = {
  attached: 'neutral',
  one_time_review: 'info',
  coordination_handoff: 'info',
  returned_to_user: 'success',
}

const CONTROL_LABELS: Record<HandoffControlKind, string> = {
  lead_stop: 'Lead stop',
  job_cancel: 'Job cancel',
  descendant_cancel: 'Descendant cancel',
  return_to_user: 'Return to user',
}

const CONTROL_ACTIONS: Record<HandoffControlKind, string> = {
  lead_stop: 'Stop lead',
  job_cancel: 'Cancel job',
  descendant_cancel: 'Cancel descendants',
  return_to_user: 'Return to user',
}

const BUSY_LABELS: Record<HandoffActionKind, string> = {
  lead_stop: 'Stopping…',
  return_to_user: 'Returning…',
}

const ROW_KINDS: readonly HandoffControlKind[] = [
  'lead_stop',
  'job_cancel',
  'descendant_cancel',
  'return_to_user',
]

export type DirectSessionHandoffControlsProps = Readonly<{
  view: DirectSessionHandoffView
  onLeadStop?: () => void | Promise<void>
  onReconnect?: () => void | Promise<void>
  onReturnToUser?: () => void | Promise<void>
  /** The in-flight coordination action, if any; lead and return rows pause while set. */
  busyAction?: HandoffActionKind
  /** The failed action's message, if any; the rows re-enable for an explicit retry. */
  actionError?: string
}>

function ControlRow(
  props: Readonly<{
    baseId: string
    kind: HandoffControlKind
    available: boolean
    reason?: string
    remediation?: string
    onAction?: () => void | Promise<void>
    busy: boolean
    busyLabel?: string
  }>
): JSX.Element {
  const reasonId = handoffControlReasonId(props.baseId, props.kind)
  const wired = () => props.onAction !== undefined
  const effective = () => props.available && wired() && !props.busy
  const showReason = () => !props.available || !wired()
  const reason = () => (!props.available ? props.reason : 'This action is not wired in this host.')
  return (
    <div class="dev-handoff__control">
      <div class="dev-handoff__control-row">
        <span class="dev-handoff__control-label">{CONTROL_LABELS[props.kind]}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!effective()}
          aria-describedby={showReason() ? reasonId : undefined}
          onClick={() => props.onAction?.()}
        >
          {props.busy && props.busyLabel ? props.busyLabel : CONTROL_ACTIONS[props.kind]}
        </Button>
      </div>
      <Show when={showReason()}>
        <p id={reasonId} class="dev-handoff__reason" role="status">
          {reason()}
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
  const noticeId = handoffControlReasonId(baseId, 'notice')
  const busyRow = (kind: HandoffControlKind): boolean =>
    (kind === 'lead_stop' || kind === 'return_to_user') && props.busyAction !== undefined
  const busyLabel = (kind: HandoffControlKind): string | undefined =>
    kind === props.busyAction ? BUSY_LABELS[kind] : undefined
  const handlerFor = (kind: HandoffControlKind): (() => void | Promise<void>) | undefined =>
    kind === 'lead_stop'
      ? props.onLeadStop
      : kind === 'return_to_user'
        ? props.onReturnToUser
        : undefined
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
        <For each={ROW_KINDS}>
          {(kind) => (
            <ControlRow
              baseId={baseId}
              kind={kind}
              available={props.view.controls[kind].available}
              reason={props.view.controls[kind].reason}
              remediation={props.view.controls[kind].remediation}
              onAction={handlerFor(kind)}
              busy={busyRow(kind)}
              busyLabel={busyLabel(kind)}
            />
          )}
        </For>
      </div>
      <Show when={props.actionError}>
        <p class="dev-handoff__error" role="alert">
          {props.actionError} Try the action again.
        </p>
      </Show>
      <Show when={props.view.draftPreserved}>
        <p class="dev-handoff__draft" role="status">
          Unsent drafts are preserved across handoff states.
        </p>
      </Show>
    </section>
  )
}
