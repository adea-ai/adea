// Direct-session handoff presentation model (#1177).
//
// A single canonical RuntimeSession/transcript/harness/execution location is
// preserved across four distinct states: read-only attachment, one-time
// review, explicit coordination handoff, and return-to-user. The model is pure
// and component-free so tests pin it without DOM.
//
// Coordination is never inferred from a bound run or from composer input
// authority: a user-created direct run is not proof of an explicit
// chief-of-staff handoff, and who may type in a box is a different dimension
// from who holds session coordination. The only path into a coordinating
// mode is a confirmed `dev.session.transferCoordination` receipt (or an explicit
// caller override): attached --handoff(chat→dev)--> coordination_handoff
// --return(dev→chat)--> returned_to_user, and back again. A live session
// with no receipt attaches read-only, even with a run bound.
//
// Authority boundary: Adea owns these presentation states, derived from
// existing `RuntimeSession`/`HarnessRun` facts and the existing
// `dev.session.*` operations. The persisted authoritative transition is
// `dev.session.transferCoordination` (generation- and owner-version-fenced,
// durable host snapshot, `session.coordination_changed` event); the model
// never invents ownership. Currency is receipt-gated: a receipt applies only to
// the session and generation it names, so a stale local receipt can never
// overwrite newer canonical ownership. Lead-turn/job/descendant
// cancellation beyond the bound harness run requires the Control Plane J2
// contract (control-plane#935: durable cancel intent, generation-bound
// retry, exact approval-before-effect, retained receipts, ambiguous-success
// reconciliation). That contract is absent from `dev-runtime-operations.json`,
// so job and descendant controls render unavailable with the exact missing
// contract named — never silently mapped onto `dev.session.cancelHarness`.
// See docs/plans/m14-1177-handoff-boundary.md for the contract the CP #935
// owner must supply. Native bridges (#936) and budgets/progress (#937) are
// likewise documented there, not invented here.
import type { ChatConversation } from './types'
import type { HarnessRun, RuntimeSession } from '@adea-ai/types/dev-runtime'

export type DirectSessionHandoffMode =
  | 'attached'
  | 'one_time_review'
  | 'coordination_handoff'
  | 'returned_to_user'

export type HandoffControlKind =
  | 'lead_stop'
  | 'job_cancel'
  | 'descendant_cancel'
  | 'return_to_user'
  | 'handoff_to_lead'

export type HandoffActionKind = 'lead_stop' | 'return_to_user' | 'handoff_to_lead'

export type HandoffControlState = Readonly<{
  available: boolean
  reason?: string
  remediation?: string
}>

/**
 * The confirmed transfer receipt: the operation epoch (session generation
 * the transfer committed at) plus its direction. Currency is decided by
 * matching both against the current canonical session — never by recency
 * of local state.
 */
export type HandoffReceipt = Readonly<{
  sessionId: string
  holder: 'lead' | 'user'
  generation: number
}>

/**
 * How the supplied harness-run candidate relates to the register binding.
 * `bound` (object fully validated) and `registered` (register id only, no
 * object facts — the same provenance `dev.session.cancelHarness` uses) both
 * authorize lead-stop; every other status names its reason instead.
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
  /** A confirmed receipt exists but names an older generation than the
   *  canonical session: newer ownership superseded it. */
  supersededReceipt: boolean
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

function transportGuard(
  input: DirectSessionHandoffInput,
  action: string
): HandoffControlState | undefined {
  if (!input.connected)
    return blocked(`${action} unavailable while offline.`, 'Reconnect the transcript to continue.')
  if (!input.generationCurrent)
    return blocked(`${action} unavailable for a stale generation.`, 'Resync the transcript first.')
  if (input.controlConflict)
    return blocked(
      `${action} paused by a control conflict.`,
      'Resolve the coordinator conflict first.'
    )
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
  } else if (input.controlConflict) {
    notice =
      'Another coordinator holds control. Resolve the conflict explicitly; no silent fallback was taken.'
  } else if (!input.scopeAuthorized) {
    notice =
      'This session belongs to another scope. Worktree and project authority are preserved; no action was taken.'
  } else if (input.session.archived) {
    notice =
      'This session is archived. Controls stay paused until it is unarchived; history is preserved.'
  } else if (input.supersededReceipt) {
    notice =
      'Coordination changed since the confirmed transfer; the receipt names older ownership. Refresh to coordinate from the current generation.'
  }

  // The register run binding shared by the run-scoped controls: only a
  // current, session-bound, non-terminal run authorizes lead-stop, and only
  // such a run (or its register id) can receive a handoff. The host
  // re-validates the exact id at commit, so a superseded binding fails
  // rather than misbinding.
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
        `Harness run ${binding.run?.state ?? 'ended'}; there is no live run to coordinate.`,
        'Resume the session to start a new harness generation.'
      )
    if (binding.status === 'absent')
      return blocked(
        'No harness run is bound to this session.',
        'Launch a harness to enable lead coordination.'
      )
    return undefined
  }

  // Lead-stop maps to the existing bound-harness control
  // (`dev.session.cancelHarness` on the register-bound run). It is available
  // only in the coordinating modes with a bindable run. Every other case
  // names its reason instead of failing silently.
  const leadStop = ((): HandoffControlState => {
    if (input.mode !== 'coordination_handoff' && input.mode !== 'returned_to_user')
      return blocked(
        'Lead control is not granted in this read-only state.',
        'Coordinate the session to enable lead controls.'
      )
    const guard = transportGuard(input, 'Lead stop')
    if (guard) return guard
    return boundRunBlock() ?? { available: true }
  })()

  // Hand-off to the lead executes the persisted `dev.session.transferCoordination`
  // binding the exact register-bound run. Offered from attachment (establishing
  // coordination) and after a return (re-establishing it): the handoff cycle is
  // explicit in both directions, never inferred.
  const handoffToLead = ((): HandoffControlState => {
    if (input.mode === 'coordination_handoff')
      return blocked(
        'Coordination is already handed off.',
        'Return the session to hand it off again.'
      )
    if (input.mode !== 'attached' && input.mode !== 'returned_to_user')
      return blocked(
        'Hand-off applies from an attached or returned session.',
        'Resolve the session state before handing off.'
      )
    const guard = transportGuard(input, 'Hand-off to lead')
    if (guard) return guard
    return boundRunBlock() ?? { available: true }
  })()

  // Return-to-user executes the persisted `dev.session.transferCoordination`
  // releasing coordination. Available only inside an explicit coordination handoff: the
  // only path to user-held coordination is a confirmed transfer, so an
  // already-returned session needs no transfer.
  const returnToUser = ((): HandoffControlState => {
    if (input.mode === 'returned_to_user')
      return blocked('Coordination is already user-held.', 'No transfer is needed.')
    if (input.mode !== 'coordination_handoff')
      return blocked(
        'Return to user applies from an active coordination handoff.',
        'Coordinate the session before returning it.'
      )
    const guard = transportGuard(input, 'Return to user')
    if (guard) return guard
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
    controls: {
      lead_stop: leadStop,
      job_cancel: jobCancel,
      descendant_cancel: descendantCancel,
      return_to_user: returnToUser,
      handoff_to_lead: handoffToLead,
    },
    ...(notice === undefined ? {} : { notice }),
    reconnectRequired,
    draftPreserved,
    awaitingApproval: input.awaitingApproval,
  }
}

/** Terminal session lifecycles: the transcript is final, so the surface is a
 *  review pass, never a coordination grant. `disconnected` is transient, not
 *  terminal — a reconnect may resume coordination. */
const TERMINAL_SESSION_LIFECYCLES: readonly string[] = ['completed', 'failed', 'cancelled']

/** A transfer receipt currency decision against the current canonical
 *  session: a receipt for this session at or past its generation is our
 *  own unobserved commit (apply its direction); a receipt behind it is
 *  superseded by newer canonical ownership (fall back, with notice). */
function receiptCurrency(
  receipt: HandoffReceipt | undefined,
  session: RuntimeSession
): 'current' | 'superseded' | 'absent' {
  if (!receipt || receipt.sessionId !== session.id) return 'absent'
  return receipt.generation >= session.generation ? 'current' : 'superseded'
}

/**
 * Derives the handoff mode from durable surface facts. No coordination
 * signal, no coordination: archived/terminal sessions review; a stale or
 * offline view attaches read-only until resync; a live session without a
 * retained owner or a current receipt attaches — even with a run bound,
 * since a bound run alone proves execution, not an explicit handoff. Only
 * the host-projected retained owner or a current receipt (our unobserved
 * commit) enters a coordinating mode, so newer canonical ownership can
 * never be overwritten by stale local state.
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

export type DirectSessionHandoffSupply = Readonly<{
  harnessRuns?: readonly HarnessRun[]
  mode?: DirectSessionHandoffMode
  receipt?: HandoffReceipt
  controlConflict?: boolean
}>

/**
 * Production supplier: builds the handoff input from one canonical
 * `ChatConversation` plus surface facts. The run candidate is resolved by
 * the register binding (`activeHarnessRunId`) and never guessed; the draft
 * flag reads the live conversation draft; coordination comes from our
 * unobserved commit first, then the host-projected retained owner, then
 * nothing asserted. An explicit mode overrides derivation; a superseded
 * receipt falls back to attachment with a notice naming the newer
 * ownership.
 */
export function deriveHandoffInputFromConversation(
  input: Readonly<{
    conversation: ChatConversation
    connected: boolean
    generationCurrent?: boolean
    scopeAuthorized?: boolean
    harnessRuns?: readonly HarnessRun[]
    awaitingApproval?: boolean
    mode?: DirectSessionHandoffMode
    receipt?: HandoffReceipt
    controlConflict?: boolean
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
  const currency = receiptCurrency(input.receipt, session)
  // Coordination holder, newest knowledge first: our unobserved commit
  // (current receipt) wins; otherwise the host-projected retained owner;
  // otherwise nothing is asserted and the session attaches.
  const coordination =
    currency === 'current' && input.receipt
      ? input.receipt.holder
      : input.conversation.coordinationOwner
  const mode =
    input.mode ??
    (staleView || !generationCurrent
      ? 'attached'
      : deriveHandoffModeForSurface({
          lifecycle,
          archived: input.conversation.archived,
          connected: input.connected,
          generationCurrent,
          coordination,
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
    mode,
    connected: input.connected,
    generationCurrent: staleView ? false : generationCurrent,
    scopeAuthorized: input.scopeAuthorized ?? true,
    hasUnsentDraft:
      input.conversation.draft.trim().length > 0 || input.conversation.draftBlocks.length > 0,
    controlConflict: input.controlConflict ?? false,
    awaitingApproval: input.awaitingApproval ?? false,
    supersededReceipt: currency === 'superseded',
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
      : kind === 'job_cancel'
        ? 'job'
        : kind === 'descendant_cancel'
          ? 'descendant'
          : kind === 'return_to_user'
            ? 'return'
            : kind === 'handoff_to_lead'
              ? 'handoff'
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
 * fenced by `isCurrent` (captured session identity): a superseded result
 * commits nothing, leaving cleanup to the session-switch reset. Success
 * carries work's result to `onSuccess` (coordination calls pass their refreshed
 * conversation so the caller can record the receipt).
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
