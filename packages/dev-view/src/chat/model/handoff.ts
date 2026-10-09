// Direct-session handoff presentation model (#1177).
//
// A single canonical RuntimeSession/transcript/harness/execution location is
// preserved across four distinct states: read-only attachment, one-time
// review, explicit coordination handoff, and return-to-user. The model is pure
// and component-free so tests pin it without DOM.
//
// Authority boundary: Adea owns these presentation states, derived from
// existing `RuntimeSession`/`HarnessRun` facts and the existing
// `dev.session.*` operations. Lead-turn/job/descendant cancellation beyond
// the bound harness run requires the Control Plane J2 contract
// (control-plane#935: durable cancel intent, generation-bound retry, exact
// approval-before-effect, retained receipts, ambiguous-success
// reconciliation). That contract is absent from `dev-runtime-operations.json`,
// so job and descendant controls render unavailable with the exact missing
// contract named — never silently mapped onto `dev.session.cancelHarness`.
// See docs/plans/m14-1177-handoff-boundary.md for the contract the CP #935
// owner must supply. Native bridges (#936) and budgets/progress (#937) are
// likewise documented there, not invented here.
import type { HarnessRun, RuntimeSession } from '@adea-ai/types/dev-runtime'

export type DirectSessionHandoffMode =
  | 'attached'
  | 'one_time_review'
  | 'coordination_handoff'
  | 'returned_to_user'

export type HandoffControlKind = 'lead_stop' | 'job_cancel' | 'descendant_cancel'

export type HandoffControlState = Readonly<{
  available: boolean
  reason?: string
  remediation?: string
}>

export type DirectSessionHandoffInput = Readonly<{
  session: RuntimeSession
  activeHarnessRun?: HarnessRun
  mode: DirectSessionHandoffMode
  connected: boolean
  generationCurrent: boolean
  scopeAuthorized: boolean
  hasUnsentDraft: boolean
  controlConflict: boolean
  awaitingApproval: boolean
}>

export type DirectSessionHandoffView = Readonly<{
  mode: DirectSessionHandoffMode
  label: string
  description: string
  preserves: Readonly<{
    runtimeSessionId: string
    generation: number
    harnessRunId?: string
    worktreeId: string
    projectId: string
  }>
  controls: Readonly<Record<HandoffControlKind, HandoffControlState>>
  notice?: string
  reconnectRequired: boolean
  draftPreserved: boolean
  awaitingApproval: boolean
}>

export const HANDOFF_MODE_LABELS: Readonly<
  Record<DirectSessionHandoffMode, { label: string; description: string }>
> = {
  attached: {
    label: 'Attached · read-only reference',
    description:
      'Read-only reference to one existing session. Attachment never duplicates execution and grants no control.',
  },
  one_time_review: {
    label: 'One-time review',
    description:
      'A single review pass over the existing transcript. Reviewing does not take control or start new work.',
  },
  coordination_handoff: {
    label: 'Coordination handoff',
    description:
      'Explicit generation-bound coordination transfer. Handoff never duplicates execution or grants unrelated control.',
  },
  returned_to_user: {
    label: 'Returned to user',
    description:
      'The lead relinquishes coordination and the user owns the session. Unsent drafts are preserved.',
  },
}

const CONTROL_PLANE_CANCEL_CONTRACT =
  'Unavailable: durable job cancellation requires the Control Plane J2 contract (control-plane#935), not yet in dev-runtime operations.'

function disabled(reason: string, remediation?: string): HandoffControlState {
  return remediation === undefined
    ? { available: false, reason }
    : { available: false, reason, remediation }
}

function blocked(reason: string, remediation?: string): HandoffControlState {
  return disabled(reason, remediation)
}

/**
 * Derives the handoff view for one preserved session. The same session,
 * generation, harness run, worktree, and project cross every mode — the
 * function mints no IDs and switches no location.
 */
export function deriveDirectSessionHandoff(
  input: DirectSessionHandoffInput
): DirectSessionHandoffView {
  const meta = HANDOFF_MODE_LABELS[input.mode]
  const harnessRunId =
    input.activeHarnessRun?.runtimeSessionId === input.session.id
      ? input.activeHarnessRun.id
      : input.session.activeHarnessRunId
  const draftPreserved = true
  const reconnectRequired = !input.connected

  let notice: string | undefined
  if (!input.connected) {
    notice =
      'Runtime offline. Controls are paused until the transcript reconnects; drafts and history are preserved.'
  } else if (!input.generationCurrent) {
    notice =
      'Session generation changed. Resync the transcript before coordinating; controls stay paused.'
  } else if (input.controlConflict) {
    notice =
      'Another coordinator holds control. Resolve the conflict explicitly; no silent fallback was taken.'
  } else if (!input.scopeAuthorized) {
    notice =
      'This session belongs to another scope. Worktree and project authority are preserved; no action was taken.'
  }

  // Lead-stop maps to the existing bound-harness control
  // (`dev.session.cancelHarness` on the bound run). It is available only in
  // the coordinating modes, while connected, on the current generation, in
  // an authorized scope, without a control conflict, and while a bound run
  // exists. Every other case names its reason instead of failing silently.
  const leadStop = ((): HandoffControlState => {
    if (input.mode !== 'coordination_handoff' && input.mode !== 'returned_to_user')
      return blocked('Lead control is not granted in this read-only state.')
    if (!input.connected)
      return blocked(
        'Lead stop unavailable while offline.',
        'Reconnect the transcript to continue.'
      )
    if (!input.generationCurrent)
      return blocked(
        'Lead stop unavailable for a stale generation.',
        'Resync the transcript first.'
      )
    if (input.controlConflict)
      return blocked(
        'Lead stop paused by a control conflict.',
        'Resolve the coordinator conflict first.'
      )
    if (!input.scopeAuthorized)
      return blocked('Lead stop unavailable outside the authorized scope.')
    if (input.session.archived) return blocked('Lead stop unavailable for an archived session.')
    if (harnessRunId === undefined) return blocked('No harness run is bound to this session.')
    return { available: true }
  })()

  // Job and descendant cancellation require the absent CP J2/J4 contracts.
  // They stay unavailable with the exact missing contract named, even when a
  // bound harness run exists — mapping them onto `cancelHarness` would
  // conflate lead, job, and descendant authority.
  const jobCancel: HandoffControlState = blocked(
    CONTROL_PLANE_CANCEL_CONTRACT,
    'Coordinate with the control-plane#935 owner for the cancel-intent contract.'
  )
  const descendantCancel: HandoffControlState = blocked(
    'Unavailable: descendant cancellation requires the Control Plane J2/J4 contracts (control-plane#935/#937), not yet in dev-runtime operations.',
    'Coordinate with the control-plane#935 owner for the descendant-cancel contract.'
  )

  return {
    mode: input.mode,
    label: meta.label,
    description: meta.description,
    preserves: {
      runtimeSessionId: input.session.id,
      generation: input.session.generation,
      ...(harnessRunId === undefined ? {} : { harnessRunId }),
      worktreeId: input.session.worktreeId,
      projectId: input.session.projectId,
    },
    controls: {
      lead_stop: leadStop,
      job_cancel: jobCancel,
      descendant_cancel: descendantCancel,
    },
    ...(notice === undefined ? {} : { notice }),
    reconnectRequired,
    draftPreserved,
    awaitingApproval: input.awaitingApproval,
  }
}
