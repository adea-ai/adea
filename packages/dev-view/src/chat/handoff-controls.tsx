// Direct-session handoff controls (#1177): the four distinct handoff states
// over one preserved RuntimeSession/transcript/harness/execution location.
//
// The surface owns no authority: every control reflects the pure
// `deriveDirectSessionHandoff` view built from observed canonical lead-turn
// facts plus register run facts. Stopping the LEAD runs only the
// caller-supplied canonical lead-turn cancel handler; stopping the SESSION
// run is a separate control on the bound harness run; job and descendant
// cancellation stay disabled with the missing Control Plane J2/J4 contract
// named; session-side handoff/return have no authorized path and fail
// closed with the integration gap. All copy uses shared primitives so
// keyboard, focus, screen-reader, zoom, and reduced-motion behavior comes
// from the design system, not local markup.
import { For, Show, createUniqueId, type JSX } from 'solid-js'

import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { StatusChip, type StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { cn } from '@adea-ai/ui/lib/utils'

import type { HandoffActivity, HandoffChildEvidence } from './model/handoff-observation'
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
  session_stop: 'Session stop',
  handoff_to_lead: 'Handoff to lead',
  job_cancel: 'Job cancel',
  descendant_cancel: 'Descendant cancel',
}

const CONTROL_ACTIONS: Record<HandoffControlKind, string> = {
  lead_stop: 'Stop lead',
  session_stop: 'Stop session run',
  handoff_to_lead: 'Hand off to lead',
  job_cancel: 'Cancel job',
  descendant_cancel: 'Cancel descendants',
}

const BUSY_LABELS: Record<HandoffActionKind, string> = {
  lead_stop: 'Stopping lead…',
  session_stop: 'Stopping session run…',
  handoff_to_lead: 'Handing off…',
}

const HOLDER_LABELS: Record<DirectSessionHandoffView['holder'], string> = {
  lead: 'Held by the workspace lead',
  user: 'Held by you',
  none: 'No one holds this session',
}

function utcTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

const ROW_KINDS: readonly HandoffControlKind[] = [
  'lead_stop',
  'session_stop',
  'handoff_to_lead',
  'job_cancel',
  'descendant_cancel',
]

export type DirectSessionHandoffControlsProps = Readonly<{
  view: DirectSessionHandoffView
  onLeadStop?: () => void | Promise<void>
  onSessionStop?: () => void | Promise<void>
  onRequestHandoff?: () => void | Promise<void>
  onReconnect?: () => void | Promise<void>
  onRefreshLead?: () => void | Promise<void>
  /** Row-specific reason when a control is available but unwired. */
  leadUnwiredReason?: string
  /** The in-flight coordination action, if any; executable rows pause while set. */
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
    unwiredReason?: string
    busy: boolean
    busyLabel?: string
  }>
): JSX.Element {
  const reasonId = handoffControlReasonId(props.baseId, props.kind)
  const wired = () => props.onAction !== undefined
  const effective = () => props.available && wired() && !props.busy
  const showReason = () => !props.available || !wired()
  const reason = () =>
    !props.available
      ? props.reason
      : (props.unwiredReason ?? 'This action is not wired in this host.')
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

/** Raw events counted from the retained window. They are evidence, never a
 *  current state: the strip says so and names an incomplete window. */
function EvidenceStrip(props: { activity: HandoffActivity }): JSX.Element {
  const a = () => props.activity
  return (
    <section class="dev-handoff__evidence" aria-label="Evidence from the retained transcript">
      <dl class="dev-handoff__evidence-list">
        <div>
          <dt>Last event</dt>
          <dd>
            <Show when={a().lastEvent} fallback="none in the retained window">
              {(last) => (
                <>
                  {last().kind} #{last().seq} · {utcTime(last().occurredAt)}
                </>
              )}
            </Show>
          </dd>
        </div>
        <div>
          <dt>Approval events</dt>
          <dd>
            {a().structured
              ? `${a().approvalRequestedEvents} requested, ${a().approvalClosedEvents} closed`
              : 'not reported by this projection'}
          </dd>
        </div>
        <div>
          <dt>Files observed</dt>
          <dd>{a().filesObserved}</dd>
        </div>
        <div>
          <dt>Subagents observed</dt>
          <dd>{a().subagentsObserved}</dd>
        </div>
        <div>
          <dt>Capability events</dt>
          <dd>
            {a().capabilityDegradedEvents} degraded, {a().capabilityRestoredEvents} restored
          </dd>
        </div>
      </dl>
      <p class="dev-handoff__evidence-note">
        Counts of raw events in the retained window, not what is open or degraded now.
        <Show when={!a().windowComplete}>
          {' '}
          The window is incomplete, so counts are lower bounds.
        </Show>
        <Show when={!a().structured}>
          {' '}
          This session is shown from terminal output, which reports no structured events.
        </Show>
      </p>
    </section>
  )
}

/** What the control plane said about delegated children. Display only: it
 *  cannot bind a cancel, and an unavailable or partial read says so. */
function ChildEvidenceSection(props: {
  evidence: HandoffChildEvidence
  jobs: DirectSessionHandoffView['childJobs']
}): JSX.Element {
  const rows = () =>
    props.evidence.kind === 'complete' || props.evidence.kind === 'partial'
      ? props.evidence.rows
      : []
  return (
    <section class="dev-handoff__children" aria-label="Child delegations">
      <p
        class="dev-handoff__children-summary"
        role="status"
        data-child-evidence={props.evidence.kind}
      >
        {props.evidence.summary}
      </p>
      <Show when={rows().length > 0}>
        <ul class="dev-handoff__child-list">
          <For each={rows()}>
            {(row) => (
              <li class="dev-handoff__child" data-child-state={row.stateText}>
                <span class="dev-handoff__child-role">{row.role}</span>
                <Badge variant="outline">{row.stateText}</Badge>
                <For each={row.qualifiers}>
                  {(text) => <Badge variant="secondary">{text}</Badge>}
                </For>
                <span class="dev-handoff__child-id" title={row.delegationId}>
                  {row.delegationId.slice(0, 8)}
                </span>
                <span class="dev-handoff__child-time">updated {utcTime(row.updatedAt)}</span>
              </li>
            )}
          </For>
        </ul>
        <p class="dev-handoff__evidence-note">
          Reported by the control plane for display. It grants no control over a child.
        </p>
      </Show>
      <Show when={props.jobs.length > 0}>
        <ul class="dev-handoff__job-list" aria-label="Observed child jobs">
          <For each={props.jobs}>
            {(job) => (
              <li class="dev-handoff__job">
                <span class="dev-handoff__child-role">{job.label}</span>
                <Badge variant="outline">{job.state.replaceAll('_', ' ')}</Badge>
                <span class="dev-handoff__child-time">
                  {plural(job.descendantCount, 'descendant', 'descendants')}
                </span>
                <p class="dev-handoff__reason">
                  Job:{' '}
                  {job.job.available
                    ? 'cancellation is authorized by an authenticated observation.'
                    : job.job.reason}{' '}
                  Descendants:{' '}
                  {job.descendants.available
                    ? 'cancellation is authorized by an authenticated observation.'
                    : job.descendants.reason}
                </p>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}

export function DirectSessionHandoffControls(
  props: DirectSessionHandoffControlsProps
): JSX.Element {
  const baseId = createUniqueId()
  const noticeId = handoffControlReasonId(baseId, 'notice')
  const busyRow = (kind: HandoffControlKind): boolean =>
    (kind === 'lead_stop' || kind === 'session_stop' || kind === 'handoff_to_lead') &&
    props.busyAction !== undefined
  const busyLabel = (kind: HandoffControlKind): string | undefined =>
    kind === props.busyAction ? BUSY_LABELS[kind] : undefined
  const handlerFor = (kind: HandoffControlKind): (() => void | Promise<void>) | undefined =>
    kind === 'lead_stop'
      ? props.onLeadStop
      : kind === 'session_stop'
        ? props.onSessionStop
        : kind === 'handoff_to_lead'
          ? props.onRequestHandoff
          : undefined
  const unwiredFor = (kind: HandoffControlKind): string | undefined =>
    kind === 'lead_stop' ? props.leadUnwiredReason : undefined
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
        <Show when={props.view.approvalState === 'unknown'}>
          <Badge variant="outline" title="Approval events cannot be matched to their requests">
            approval status unknown
          </Badge>
        </Show>
        <Show when={props.view.coordination}>
          {(coordination) => (
            <Badge variant="outline" title={`Coordinating lead turn ${coordination().intentId}`}>
              lead {coordination().state.replaceAll('_', ' ')}
            </Badge>
          )}
        </Show>
      </div>
      <p class="dev-handoff__holder" data-holder={props.view.holder}>
        {HOLDER_LABELS[props.view.holder]}
        <Show when={props.view.returnedReason}>
          {(reason) => <> · returned because the turn {reason().replaceAll('_', ' ')}</>}
        </Show>
      </p>
      <p class="dev-handoff__description">{props.view.description}</p>
      <p class="dev-handoff__preserved">
        One session, transcript, harness, and execution location are preserved; worktree and project
        authority are unchanged.
      </p>
      <Show when={props.view.notice}>
        <div
          id={noticeId}
          class={cn(
            'flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted-foreground',
            {
              'dev-handoff__notice--offline': props.view.reconnectRequired,
            }
          )}
          role="alert"
        >
          <p>{props.view.notice}</p>
          <Show when={props.view.reconnectRequired && props.onReconnect}>
            <Button type="button" variant="outline" size="sm" onClick={() => props.onReconnect?.()}>
              Reconnect transcript
            </Button>
          </Show>
          <Show when={props.view.awaitingTurn && props.onRefreshLead}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => props.onRefreshLead?.()}
            >
              Check lead status
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={props.view.activity}>
        {(activity) => <EvidenceStrip activity={activity()} />}
      </Show>
      <ChildEvidenceSection evidence={props.view.childEvidence} jobs={props.view.childJobs} />
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
              unwiredReason={unwiredFor(kind)}
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
