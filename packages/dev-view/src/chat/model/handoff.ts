// Direct-session handoff presentation model (#1177).
//
// A single canonical RuntimeSession/transcript/harness/execution location is
// preserved across four distinct states: read-only attachment, one-time
// review, explicit coordination handoff, and return-to-user. The model is
// pure and component-free so tests pin it without DOM.
//
// Coordination comes only from supplied canonical lead-turn facts — the
// workspace lead's admitted intent identity plus its observed live
// execution — and never from a bound run, composer authority, or view
// routing, none of which prove a chief-of-staff handoff. A user-created
// direct run is execution, not delegation. Where the surface cannot
// observe the lead (no facts supplied), lead rows fail closed with the
// integration gap named instead of inventing control. Stopping the LEAD
// (the canonical lead-turn cancel path, caller-supplied) is distinct from
// stopping the SESSION run (`dev.session.cancelHarness` on the bound run),
// which is distinct from job/descendant cancellation (Control Plane
// contracts, absent here). See docs/plans/m14-1177-handoff-boundary.md.
import type { AgentLifecycleState } from '@adea-ai/types'
import type { ChatConversation } from './types'
import type { HarnessRun, RuntimeSession } from '@adea-ai/types/dev-runtime'

export type DirectSessionHandoffMode =
  | 'attached'
  | 'one_time_review'
  | 'coordination_handoff'
  | 'returned_to_user'

export type HandoffControlKind =
  | 'lead_stop'
  | 'session_stop'
  | 'handoff_to_lead'
  | 'job_cancel'
  | 'descendant_cancel'

export type HandoffActionKind = 'lead_stop' | 'session_stop' | 'handoff_to_lead'

export type HandoffControlState = Readonly<{
  available: boolean
  reason?: string
  remediation?: string
}>

/**
 * Caller-observed canonical lead-turn facts. The identity is the lead's
 * admitted intent (`lead-turn:<id>` dispatch key family); the live
 * execution is its observed dispatch state. State names and the
 * cancellable/terminal split mirror the canonical lead-turn contract
 * (`@adea-ai/api-client` lead-turns plus workspace-ui `leadTurnCanCancel`:
 * cancellable starting/running/awaiting_input/cancelling, terminal
 * completed/failed/cancelled/timed_out) without importing its packages:
 * this surface projects observed facts, it never re-derives lead authority.
 */
export type HandoffLeadTurnState =
  | 'blocked'
  | 'prepared'
  | 'dispatch_pending'
  | 'starting'
  | 'running'
  | 'awaiting_input'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'unknown'

/**
 * The observed workspace chief-of-staff: the designated lead agent record
 * (`isWorkspaceLead`, workspace-scoped, active lifecycle). Mirrors the
 * canonical agent projection without importing its packages: this surface
 * projects observed facts, it never re-derives lead authority.
 */
export type HandoffLeadAgent = Readonly<{
  id: string
  isWorkspaceLead: boolean
  lifecycleState: AgentLifecycleState
}>

export type HandoffLeadTurn = Readonly<{
  /** Canonical lead-turn intent id. Never invented: absent means unobserved. */
  intentId: string
  /** Exact admission target retained on the intent. A turn whose target is
   *  absent or names another session never coordinates this one. */
  handoffTarget?: Readonly<{
    runtimeSessionId: string
    taskId?: string
    observedGeneration: number
  }>
  /** The turn's owning agent id: must equal the workspace lead's id. */
  agentId: string
  /** Live execution binding when dispatched. */
  dispatchId?: string
  state: HandoffLeadTurnState
  /** Caller-observed cancellation availability for this turn. */
  canCancel: boolean
  /** Admission refusal code when state is blocked. */
  reasonCode?: string
  /** Runtime-validated execution binding: the session the control plane
   *  observed this turn executing in. Absent means never observed — a
   *  retained request alone, however live it looks, is not authority. */
  observedRuntimeSessionId?: string
}>

const LIVE_LEAD_TURN_STATES: readonly HandoffLeadTurnState[] = [
  'prepared',
  'dispatch_pending',
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
]

const TERMINAL_LEAD_TURN_STATES: readonly HandoffLeadTurnState[] = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]

/**
 * How the supplied harness-run candidate relates to the register binding.
 * `bound` (object fully validated) and `registered` (register id only, no
 * object facts — the same provenance `dev.session.cancelHarness` uses) both
 * authorize session-stop; every other status names its reason instead. A
 * replacement register id never inherits the old candidate: a superseded
 * object is stale, and the refresh must supply the new one explicitly.
 */
export type HarnessRunBinding =
  | 'bound'
  | 'registered'
  | 'terminal'
  | 'stale'
  | 'mismatch'
  | 'absent'

/** Terminal harness states mirror the Agents pane precedence: a run in one of
 *  these states is over, so stop controls name the state instead of offering
 *  a stop that cannot land. */
const TERMINAL_HARNESS_RUN_STATES: readonly string[] = [
  'completed',
  'failed',
  'cancelled',
  'disconnected',
]

function scopesEqual(left: HarnessRun['scope'], right: RuntimeSession['scope']): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

export function resolveHarnessRunBinding(
  session: RuntimeSession,
  candidate: HarnessRun | undefined
): { status: HarnessRunBinding; run?: HarnessRun } {
  if (candidate === undefined) {
    if (session.activeHarnessRunId === undefined) return { status: 'absent' }
    return { status: 'registered' }
  }
  if (candidate.runtimeSessionId !== session.id) return { status: 'mismatch' }
  if (!scopesEqual(candidate.scope, session.scope)) return { status: 'mismatch' }
  if (candidate.id !== session.activeHarnessRunId) return { status: 'stale', run: candidate }
  if (TERMINAL_HARNESS_RUN_STATES.includes(candidate.state))
    return { status: 'terminal', run: candidate }
  return { status: 'bound', run: candidate }
}

/**
 * Binds an observed turn to the observed workspace lead. Both facts must be
 * supplied and agree: the turn's owning agent must equal the designated
 * active workspace lead. Anything else — a turn from another agent, a
 * non-lead or inactive designation — is not chief-of-staff coordination,
 * and the caller must not present it as such.
 */
/**
 * Requested reference check: the turn names this session as its handoff
 * target and belongs to the workspace lead. A claim is routing, never
 * authority: passing it means the request is tracked, not granted.
 */
export function resolveLeadClaim(
  leadTurn: HandoffLeadTurn | undefined,
  leadAgent: HandoffLeadAgent | undefined,
  runtimeSessionId?: string
): { bound: boolean; reason?: string } {
  if (!leadTurn || !leadAgent) return { bound: false }
  if (leadTurn.agentId !== leadAgent.id)
    return { bound: false, reason: 'the observed turn belongs to another agent' }
  if (!leadAgent.isWorkspaceLead)
    return { bound: false, reason: 'the observed agent is not the designated workspace lead' }
  if (leadAgent.lifecycleState !== 'active')
    return {
      bound: false,
      reason: `the workspace lead is ${leadAgent.lifecycleState}, not active`,
    }
  if (runtimeSessionId !== undefined) {
    const target = leadTurn.handoffTarget?.runtimeSessionId
    if (target === undefined)
      return { bound: false, reason: 'the observed turn names no handoff target' }
    if (target !== runtimeSessionId)
      return { bound: false, reason: 'the observed turn targets another session' }
  }
  return { bound: true }
}

export function resolveLeadCoordination(
  leadTurn: HandoffLeadTurn | undefined,
  leadAgent: HandoffLeadAgent | undefined,
  session?: Readonly<{ id: string; generation: number }>
): { bound: boolean; reason?: string } {
  if (!leadTurn || !leadAgent) return { bound: false }
  // Coordination needs the claim first, then the effect boundary: only a
  // runtime-validated execution binding observed in THIS session, at the
  // generation the session currently shows, establishes coordination. A
  // retained request — or even a running lead — alone never coordinates,
  // no matter how live it looks: ordering among requests is recency, and
  // recency of caller claims proves nothing about control.
  const claim =
    session === undefined
      ? resolveLeadClaim(leadTurn, leadAgent)
      : resolveLeadClaim(leadTurn, leadAgent, session.id)
  if (!claim.bound) return claim
  if (session === undefined) return { bound: true }
  const observed = leadTurn.observedRuntimeSessionId
  if (observed === undefined)
    return { bound: false, reason: 'the observed turn has no runtime-validated execution binding' }
  if (observed !== session.id)
    return { bound: false, reason: 'the observed turn executes in another session' }
  const target = leadTurn.handoffTarget
  if (target !== undefined && target.observedGeneration !== session.generation)
    return {
      bound: false,
      reason: `the observed turn targets generation ${target.observedGeneration} but the session is at generation ${session.generation}`,
    }
  return { bound: true }
}

export type DirectSessionHandoffInput = Readonly<{
  session: RuntimeSession
  activeHarnessRun?: HarnessRun
  leadTurn?: HandoffLeadTurn
  /** The turn requesting this session, if any: claim-matched but not
   *  necessarily runtime-validated. Drives requested-tracking only. */
  claimedTurn?: HandoffLeadTurn
  leadAgent?: HandoffLeadAgent
  /** A supplied turn failed the lead-agent binding check below. */
  leadMismatch: boolean
  /** Why the supplied turn is unbound, when known. */
  leadMismatchReason?: string
  /** Exactly one linked lead channel observed; absent means unknown. */
  leadChannelId?: string
  mode: DirectSessionHandoffMode
  connected: boolean
  generationCurrent: boolean
  scopeAuthorized: boolean
  hasUnsentDraft: boolean
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
  binding: HarnessRunBinding
  /** The observed lead-turn coordination, echoed for provenance. Absent
   *  exactly when no lead facts were supplied. */
  coordination?: Readonly<{
    intentId: string
    dispatchId?: string
    state: HandoffLeadTurnState
  }>
  controls: Readonly<Record<HandoffControlKind, HandoffControlState>>
  notice?: string
  reconnectRequired: boolean
  draftPreserved: boolean
  awaitingApproval: boolean
  /** A handoff was requested and its turn is still pending admission. */
  awaitingTurn: boolean
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
      'The workspace lead coordinates this session under an explicitly observed turn. Handoff never duplicates execution or grants unrelated control.',
  },
  returned_to_user: {
    label: 'Returned to user',
    description:
      'The lead turn ended and the user owns the session again. Unsent drafts are preserved.',
  },
}
const LEAD_INTEGRATION_GAP =
  'No lead-turn contract is connected in this surface: coordination is established through lead-turn admission, and stopping the lead goes through the canonical lead-turn cancel path (control-plane#933 family).'

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

function transportGuard(
  input: DirectSessionHandoffInput,
  action: string
): HandoffControlState | undefined {
  if (!input.connected)
    return blocked(`${action} unavailable while offline.`, 'Reconnect the transcript to continue.')
  if (!input.generationCurrent)
    return blocked(`${action} unavailable for a stale generation.`, 'Resync the transcript first.')
  if (!input.scopeAuthorized)
    return blocked(
      `${action} unavailable outside the authorized scope.`,
      'Open the session in its authorized scope.'
    )
  if (input.session.archived)
    return blocked(
      `${action} unavailable for an archived session.`,
      'Unarchive the session to coordinate it.'
    )
  return undefined
}

/**
 * Derives the handoff view for one preserved session. The same session,
 * generation, harness run, worktree, and project cross every mode — the
 * function mints no IDs and switches no location. A run object newer or
 * older than the session generation still binds: coordination transfers bump
 * the session generation without replacing the run (accepted host contract),
 * so run/session generation equality is never required.
 */
export function deriveDirectSessionHandoff(
  input: DirectSessionHandoffInput
): DirectSessionHandoffView {
  const meta = HANDOFF_MODE_LABELS[input.mode]
  const binding = resolveHarnessRunBinding(input.session, input.activeHarnessRun)
  const harnessRunId = input.session.activeHarnessRunId
  const draftPreserved = true
  const reconnectRequired = !input.connected

  let notice: string | undefined
  if (!input.connected) {
    notice =
      'Runtime offline. Controls are paused until the transcript reconnects; drafts and history are preserved.'
  } else if (!input.generationCurrent) {
    notice =
      'Session generation changed. Resync the transcript before coordinating; controls stay paused.'
  } else if (!input.scopeAuthorized) {
    notice =
      'This session belongs to another scope. Worktree and project authority are preserved; no action was taken.'
  } else if (input.session.archived) {
    notice =
      'This session is archived. Controls stay paused until it is unarchived; history is preserved.'
  } else if (input.mode === 'attached' && input.leadTurn?.state === 'blocked') {
    notice = `Lead coordination unavailable${
      input.leadTurn.reasonCode ? `: ${input.leadTurn.reasonCode}` : ''
    }. The session stays read-only.`
  } else if (
    input.mode === 'attached' &&
    input.claimedTurn !== undefined &&
    (input.claimedTurn.state === 'blocked' || input.claimedTurn.state === 'unknown')
  ) {
    notice =
      'Lead coordination requested for this session. The request is retained but unvalidated: coordination establishes only when the runtime observes execution bound to this session.'
  } else if (input.leadMismatch) {
    notice =
      input.leadMismatchReason !== undefined
        ? `The observed turn is not bound to this session (${input.leadMismatchReason}), so it grants no coordination. The session stays read-only.`
        : 'The supplied turn is not bound to the active workspace lead, so it grants no coordination. The session stays read-only.'
  }

  // Stopping the LEAD cancels the canonical lead turn through the
  // caller-supplied handler — never the session's harness run. Available
  // only inside an explicitly observed live turn whose caller reports it
  // cancellable. Every other case names its reason instead of failing
  // silently, and a missing turn fails closed with the integration gap.
  const leadStop = ((): HandoffControlState => {
    if (!input.leadTurn || input.leadMismatch)
      return blocked(
        'No lead turn is bound to this session.',
        `Lead cancellation lives with the workspace lead. ${LEAD_INTEGRATION_GAP}`
      )
    if (input.mode !== 'coordination_handoff')
      return blocked(
        'Lead control is not granted in this state.',
        'Coordinate the session under a live lead turn to enable lead controls.'
      )
    const guard = transportGuard(input, 'Lead stop')
    if (guard) return guard
    if (!LIVE_LEAD_TURN_STATES.includes(input.leadTurn.state))
      return blocked(
        `The lead turn is ${input.leadTurn.state}; there is no live lead execution to stop.`,
        'Resolve the lead turn state before stopping.'
      )
    if (!input.leadTurn.canCancel)
      return blocked(
        'The lead turn cannot accept cancellation in its current state.',
        'Wait for dispatch or resolve the turn first.'
      )
    return { available: true }
  })()

  // The register run binding shared by the session-run stop: only a
  // current, session-bound, non-terminal run authorizes it. A replacement
  // register id never inherits an older candidate — the refresh must supply
  // the new run object explicitly, or the stale one stays flagged.
  const boundRunBlock = (): HandoffControlState | undefined => {
    if (binding.status === 'stale')
      return blocked(
        'A newer harness run superseded this one; acting on it would miss the live run.',
        'Refresh the session to resolve the current run.'
      )
    if (binding.status === 'mismatch')
      return blocked(
        'The supplied harness run belongs to another session or scope.',
        'Resolve the session-bound run first.'
      )
    if (binding.status === 'terminal')
      return blocked(
        `Harness run ${binding.run?.state ?? 'ended'}; there is no live run to stop.`,
        'Resume the session to start a new harness generation.'
      )
    if (binding.status === 'absent')
      return blocked(
        'No harness run is bound to this session.',
        'Launch a harness to enable session controls.'
      )
    return undefined
  }

  // Stopping the SESSION run cancels the bound harness run
  // (`dev.session.cancelHarness`). This is session authority, not lead
  // authority: it never implies lead-turn cancellation, and a lead-cancel
  // never implies it. Available in any non-review mode with a bindable run.
  const sessionStop = ((): HandoffControlState => {
    if (input.mode === 'one_time_review')
      return blocked(
        'Session control is not granted in this read-only state.',
        'Reopen the session to enable session controls.'
      )
    const guard = transportGuard(input, 'Session stop')
    if (guard) return guard
    return boundRunBlock() ?? { available: true }
  })()

  // Handing off requests lead coordination through the caller-supplied
  // admission handler: available from attachment (or a returned session
  // re-engaging) while exactly one linked channel is known and no turn is
  // currently observed there. A live observed turn blocks a second
  // admission; without a linked channel there is no target to ask.
  // Returning happens by completing or cancelling the turn itself, so no
  // separate return action exists: the returned mode is the distinction.
  const handoffToLead = ((): HandoffControlState => {
    if (input.mode === 'coordination_handoff')
      return blocked(
        'Coordination is already handed off.',
        'Complete or cancel the turn to return the session.'
      )
    if (input.mode !== 'attached' && input.mode !== 'returned_to_user')
      return blocked(
        'Hand-off applies from an attached or returned session.',
        'Resolve the session state before handing off.'
      )
    const guard = transportGuard(input, 'Hand-off to lead')
    if (guard) return guard
    if (input.leadChannelId === undefined)
      return blocked(
        'No lead channel references this session.',
        'Ask the workspace lead for a task topic, or coordinate through lead-turn admission.'
      )
    // Exactly one outstanding request per session: a live, prepared, or
    // unresolvable turn CLAIMING this exact session blocks a second
    // request, whether or not it is runtime-validated yet. A stuck
    // (blocked) claim may be explicitly re-requested, and a terminal turn
    // in returned mode may re-engage. Combined with canonical server-side
    // recovery (complete target dedupes) and single-flight admission, this
    // leaves no silent duplication path.
    if (input.claimedTurn !== undefined) {
      if (
        LIVE_LEAD_TURN_STATES.includes(input.claimedTurn.state) ||
        input.claimedTurn.state === 'unknown'
      )
        return blocked(
          'A lead turn is already outstanding for this session.',
          'Track the retained request instead of requesting another.'
        )
    }
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
    binding: binding.status,
    ...(input.leadTurn === undefined || input.leadMismatch
      ? {}
      : {
          coordination: {
            intentId: input.leadTurn.intentId,
            ...(input.leadTurn.dispatchId !== undefined
              ? { dispatchId: input.leadTurn.dispatchId }
              : {}),
            state: input.leadTurn.state,
          },
        }),
    controls: {
      lead_stop: leadStop,
      session_stop: sessionStop,
      handoff_to_lead: handoffToLead,
      job_cancel: jobCancel,
      descendant_cancel: descendantCancel,
    },
    ...(notice === undefined ? {} : { notice }),
    reconnectRequired,
    draftPreserved,
    awaitingApproval: input.awaitingApproval,
    awaitingTurn:
      input.mode === 'attached' &&
      input.claimedTurn !== undefined &&
      (input.claimedTurn.state === 'blocked' || input.claimedTurn.state === 'unknown'),
  }
}

/** Terminal session lifecycles: the transcript is final, so the surface is a
 *  review pass, never a coordination grant. `disconnected` is transient, not
 *  terminal — a reconnect may resume coordination. */
const TERMINAL_SESSION_LIFECYCLES: readonly string[] = ['completed', 'failed', 'cancelled']

/**
 * Derives the handoff mode from durable surface facts plus the observed
 * lead turn. No lead facts, no coordination: archived/terminal sessions
 * review; a stale or offline view attaches read-only until resync; a live
 * session without an explicitly observed lead turn attaches — even with a
 * run bound, since a bound run alone proves execution, not a chief-of-staff
 * handoff. A live observed turn means an active handoff; a terminally
 * observed turn means the session returned to the user.
 */
export function deriveHandoffModeForSurface(
  input: Readonly<{
    lifecycle: RuntimeSession['lifecycle']
    archived: boolean
    connected: boolean
    generationCurrent: boolean
    coordination: 'lead' | 'user' | undefined
  }>
): DirectSessionHandoffMode {
  if (input.archived || TERMINAL_SESSION_LIFECYCLES.includes(input.lifecycle))
    return 'one_time_review'
  if (!input.connected || !input.generationCurrent) return 'attached'
  if (input.coordination === 'lead') return 'coordination_handoff'
  if (input.coordination === 'user') return 'returned_to_user'
  return 'attached'
}

/**
 * Maps a bound turn's observed state to its coordination holder: terminal
 * turns released the session back to the user, anything else still
 * coordinates under the lead. Blocked/unknown turns never reach here —
 * the supplier attaches for those before consulting the holder.
 */
export function leadTurnCoordination(turn: HandoffLeadTurn): 'lead' | 'user' | undefined {
  if (turn.state === 'blocked' || turn.state === 'unknown') return undefined
  if (TERMINAL_LEAD_TURN_STATES.includes(turn.state)) return 'user'
  return 'lead'
}

export type DirectSessionHandoffSupply = Readonly<{
  harnessRuns?: readonly HarnessRun[]
  mode?: DirectSessionHandoffMode
  leadTurn?: HandoffLeadTurn
  leadAgent?: HandoffLeadAgent
  /** Exactly one linked lead channel observed; absent means unknown. */
  leadChannelId?: string
}>

/**
 * Production supplier: builds the handoff input from one canonical
 * `ChatConversation` plus surface facts. The run candidate is resolved by
 * the register binding (`activeHarnessRunId`) and never guessed; the draft
 * flag reads the live conversation draft; coordination comes only from the
 * supplied lead-turn facts, never inferred. An explicit mode overrides
 * derivation.
 */
/**
 * Whether the retained transcript window ends with an open approval: more
 * `approval.requested` events than closing (`resolved`/`expired`) ones.
 * This mirrors exactly what the transcript surface shows, so the handoff
 * badge never claims knowledge beyond the visible window. An explicit
 * caller value always wins.
 */
export function hasOpenApproval(events: readonly { kind: string }[]): boolean {
  let open = 0
  for (const event of events) {
    if (event.kind === 'approval.requested') open += 1
    else if (event.kind === 'approval.resolved' || event.kind === 'approval.expired')
      open = Math.max(0, open - 1)
  }
  return open > 0
}

export function deriveHandoffInputFromConversation(
  input: Readonly<{
    conversation: ChatConversation
    connected: boolean
    generationCurrent?: boolean
    scopeAuthorized?: boolean
    harnessRuns?: readonly HarnessRun[]
    awaitingApproval?: boolean
    mode?: DirectSessionHandoffMode
    leadTurn?: HandoffLeadTurn
    leadAgent?: HandoffLeadAgent
    leadChannelId?: string
  }>
): DirectSessionHandoffInput {
  const generationCurrent = input.generationCurrent ?? true
  const lifecycle =
    input.conversation.status === 'stale_generation'
      ? ('disconnected' as const)
      : input.conversation.status
  const session: RuntimeSession = {
    id: input.conversation.runtimeSessionId,
    scope: input.conversation.scope,
    projectId: input.conversation.projectId,
    repoId: input.conversation.repoId,
    worktreeId: input.conversation.worktreeId,
    generation: input.conversation.generation,
    version: input.conversation.version,
    archived: input.conversation.archived,
    lifecycle,
    projection: input.conversation.projection,
    ...(input.conversation.activeHarnessRunId === undefined
      ? {}
      : { activeHarnessRunId: input.conversation.activeHarnessRunId }),
  }
  const staleView = input.conversation.status === 'stale_generation'
  // The turn counts only when bound to the observed workspace lead. An
  // unbound turn is stripped before derivation so it can neither drive a
  // mode nor authorize lead-stop; the mismatch flag names it instead.
  const claim = resolveLeadClaim(
    input.leadTurn,
    input.leadAgent,
    input.conversation.runtimeSessionId
  )
  const claimedTurn = claim.bound ? input.leadTurn : undefined
  const coordination = resolveLeadCoordination(input.leadTurn, input.leadAgent, {
    id: input.conversation.runtimeSessionId,
    generation: input.conversation.generation,
  })
  const boundTurn = coordination.bound ? input.leadTurn : undefined
  const mode =
    input.mode ??
    (staleView || !generationCurrent
      ? 'attached'
      : deriveHandoffModeForSurface({
          lifecycle,
          archived: input.conversation.archived,
          connected: input.connected,
          generationCurrent,
          coordination: boundTurn === undefined ? undefined : leadTurnCoordination(boundTurn),
        }))
  const base: DirectSessionHandoffInput = {
    session,
    ...(input.harnessRuns?.find((run) => run.id === input.conversation.activeHarnessRunId) ===
    undefined
      ? {}
      : {
          activeHarnessRun: input.harnessRuns?.find(
            (run) => run.id === input.conversation.activeHarnessRunId
          ),
        }),
    ...(boundTurn === undefined ? {} : { leadTurn: boundTurn }),
    ...(claimedTurn === undefined ? {} : { claimedTurn }),
    ...(input.leadAgent === undefined ? {} : { leadAgent: input.leadAgent }),
    leadMismatch: !coordination.bound && input.leadTurn !== undefined,
    ...(coordination.reason === undefined ? {} : { leadMismatchReason: coordination.reason }),
    ...(input.leadChannelId === undefined ? {} : { leadChannelId: input.leadChannelId }),
    mode,
    connected: input.connected,
    generationCurrent: staleView ? false : generationCurrent,
    scopeAuthorized: input.scopeAuthorized ?? true,
    hasUnsentDraft:
      input.conversation.draft.trim().length > 0 || input.conversation.draftBlocks.length > 0,
    awaitingApproval: input.awaitingApproval ?? hasOpenApproval(input.conversation.events),
  }
  return base
}

/** Deterministic reason-element id for a control row. Pure so tests pin the
 *  `aria-describedby` linkage the component renders. */
export function handoffControlReasonId(
  baseId: string,
  kind: HandoffControlKind | 'notice'
): string {
  const suffix =
    kind === 'lead_stop'
      ? 'lead'
      : kind === 'session_stop'
        ? 'session'
        : kind === 'handoff_to_lead'
          ? 'handoff'
          : kind === 'job_cancel'
            ? 'job'
            : kind === 'descendant_cancel'
              ? 'descendant'
              : 'notice'
  return `${baseId}-${suffix}-reason`
}

export type HandoffActionState =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'busy'; action: HandoffActionKind }>
  | Readonly<{ status: 'error'; action: HandoffActionKind; message: string }>

export const initialHandoffActionState: HandoffActionState = { status: 'idle' }

export type HandoffActionEvent =
  | Readonly<{ type: 'start'; action: HandoffActionKind }>
  | Readonly<{ type: 'succeed' }>
  | Readonly<{ type: 'fail'; action: HandoffActionKind; message: string }>

/**
 * Single-flight coordination-action machine. A start while busy is ignored
 * (no double-submit); failure parks the message for an explicit retry; a
 * fail naming another action never clobbers the busy one. The component owns
 * rendering; this owns the transitions so interaction behavior is pinned
 * without a DOM runner.
 */
export function handoffActionReducer(
  state: HandoffActionState,
  event: HandoffActionEvent
): HandoffActionState {
  switch (event.type) {
    case 'start':
      return state.status === 'busy' ? state : { status: 'busy', action: event.action }
    case 'succeed':
      return { status: 'idle' }
    case 'fail':
      return state.status === 'busy' && state.action !== event.action
        ? state
        : { status: 'error', action: event.action, message: event.message }
  }
}

export type HandoffActionOutcome = 'completed' | 'rejected' | 'superseded'

/**
 * The exact production admission path (`ChatView` delegates to it): admit
 * through the reducer first and invoke work only when admitted, so a second
 * start can never cause a second effect — the reducer tests alone cannot
 * prove this because they never gate an invocation. Late completions are
 * fenced by `isCurrent` (captured session identity plus the monotonic
 * view/action epoch): a superseded result commits nothing, leaving cleanup
 * to the session-switch reset. Success carries work's result to `onSuccess`.
 */
export async function runHandoffActionOnce(
  input: Readonly<{
    current: () => HandoffActionState
    commit: (state: HandoffActionState) => void
    action: HandoffActionKind
    work: () => unknown | Promise<unknown>
    isCurrent?: () => boolean
    isConflict?: (error: unknown) => boolean
    onConflict?: () => void
    onSuccess?: (result: unknown) => void
    /** Invoked synchronously exactly when the start is admitted (never on
     *  rejection): the caller advances its view/action epoch here so late
     *  completions from replaced invocations fail the currency check. */
    onAdmitted?: () => void
  }>
): Promise<HandoffActionOutcome> {
  const before = input.current()
  const started = handoffActionReducer(before, { type: 'start', action: input.action })
  if (started === before) return 'rejected'
  input.commit(started)
  input.onAdmitted?.()
  let result: unknown
  try {
    result = await input.work()
  } catch (error) {
    if (input.isCurrent && !input.isCurrent()) return 'superseded'
    const message = error instanceof Error ? error.message : 'Handoff action failed.'
    input.commit(handoffActionReducer(started, { type: 'fail', action: input.action, message }))
    if (input.isConflict?.(error)) input.onConflict?.()
    return 'completed'
  }
  if (input.isCurrent && !input.isCurrent()) return 'superseded'
  input.commit(handoffActionReducer(started, { type: 'succeed' }))
  input.onSuccess?.(result)
  return 'completed'
}
