// Direct-session handoff presentation model (#1177).
//
// A single canonical RuntimeSession/transcript/harness/execution location is
// preserved across four distinct states: read-only attachment, one-time
// review, explicit coordination handoff, and return-to-user. The model is pure
// and component-free so tests pin it without DOM.
//
// Authority boundary: Adea owns these presentation states, derived from
// existing `RuntimeSession`/`HarnessRun` facts and the existing
// `dev.session.*` operations. The persisted authoritative transition is
// `dev.session.transferInput` (generation- and owner-version-fenced,
// durable host snapshot, `session.input_transferred` event); the model never
// invents ownership. Lead-turn/job/descendant cancellation beyond the bound
// harness run requires the Control Plane J2 contract (control-plane#935:
// durable cancel intent, generation-bound retry, exact
// approval-before-effect, retained receipts, ambiguous-success
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

export type HandoffControlKind = 'lead_stop' | 'job_cancel' | 'descendant_cancel' | 'return_to_user'

export type HandoffActionKind = 'lead_stop' | 'return_to_user'

export type HandoffControlState = Readonly<{
  available: boolean
  reason?: string
  remediation?: string
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
  /** True when this surface holds input authority (chat surface + authority). */
  inputOwnedHere: boolean
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

/**
 * Derives the handoff view for one preserved session. The same session,
 * generation, harness run, worktree, and project cross every mode — the
 * function mints no IDs and switches no location. A run object newer or
 * older than the session generation still binds: input transfers bump the
 * session generation without replacing the run, so run/session generation
 * equality is never required.
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
  }

  // Lead-stop maps to the existing bound-harness control
  // (`dev.session.cancelHarness` on the register-bound run). It is available
  // only in the coordinating modes, while connected, on the current
  // generation, in an authorized scope, without a control conflict, and while
  // the register binds a run that is not superseded, foreign, or terminal.
  // Every other case names its reason instead of failing silently.
  const leadStop = ((): HandoffControlState => {
    if (input.mode !== 'coordination_handoff' && input.mode !== 'returned_to_user')
      return blocked(
        'Lead control is not granted in this read-only state.',
        'Coordinate the session to enable lead controls.'
      )
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
      return blocked(
        'Lead stop unavailable outside the authorized scope.',
        'Open the session in its authorized scope.'
      )
    if (input.session.archived)
      return blocked(
        'Lead stop unavailable for an archived session.',
        'Unarchive the session to coordinate it.'
      )
    if (binding.status === 'stale')
      return blocked(
        'A newer harness run superseded this one; stopping it would miss the live run.',
        'Refresh the session to resolve the current run.'
      )
    if (binding.status === 'mismatch')
      return blocked(
        'The supplied harness run belongs to another session or scope.',
        'Resolve the session-bound run before stopping.'
      )
    if (binding.status === 'terminal')
      return blocked(
        `Harness run ${binding.run?.state ?? 'ended'}; there is no live run to stop.`,
        'Resume the session to start a new harness generation.'
      )
    if (binding.status === 'absent')
      return blocked(
        'No harness run is bound to this session.',
        'Launch a harness to enable lead controls.'
      )
    return { available: true }
  })()

  // Return-to-user executes the persisted `dev.session.transferInput` to this
  // surface. It is guarded exactly like lead-stop, and additionally requires
  // the coordinating mode with input held elsewhere: returning what is
  // already held here would bump the generation for no effect.
  const returnToUser = ((): HandoffControlState => {
    if (input.mode === 'returned_to_user')
      return blocked('Coordination is already user-held.', 'No transfer is needed.')
    if (input.mode !== 'coordination_handoff')
      return blocked(
        'Return to user applies from an active coordination handoff.',
        'Coordinate the session before returning it.'
      )
    if (!input.connected)
      return blocked(
        'Return to user unavailable while offline.',
        'Reconnect the transcript to continue.'
      )
    if (!input.generationCurrent)
      return blocked(
        'Return to user unavailable for a stale generation.',
        'Resync the transcript first.'
      )
    if (input.controlConflict)
      return blocked(
        'Return to user paused by a control conflict.',
        'Resolve the coordinator conflict first.'
      )
    if (!input.scopeAuthorized)
      return blocked(
        'Return to user unavailable outside the authorized scope.',
        'Open the session in its authorized scope.'
      )
    if (input.session.archived)
      return blocked(
        'Return to user unavailable for an archived session.',
        'Unarchive the session to coordinate it.'
      )
    if (input.inputOwnedHere)
      return blocked('Input is already held here.', 'No transfer is needed.')
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
    },
    ...(notice === undefined ? {} : { notice }),
    reconnectRequired,
    draftPreserved,
    awaitingApproval: input.awaitingApproval,
  }
}

/** Input authority from the composing surface's perspective. Mirrors
 *  `ChatInputAuthority` without importing the composer (this module stays
 *  dependency-free). */
export type HandoffSurfaceAuthority = 'chat' | 'dev' | 'none'

/** Terminal session lifecycles: the transcript is final, so the surface is a
 *  review pass, never a coordination grant. `disconnected` is transient, not
 *  terminal — a reconnect may resume coordination. */
const TERMINAL_SESSION_LIFECYCLES: readonly string[] = ['completed', 'failed', 'cancelled']

/**
 * Derives the handoff mode from durable surface facts. No new persisted
 * field: archived/terminal sessions review; a stale view attaches read-only
 * until resync; otherwise the input owner decides — this surface coordinates,
 * any other surface attaches.
 */
export function deriveHandoffModeForSurface(
  input: Readonly<{
    authority: HandoffSurfaceAuthority
    lifecycle: RuntimeSession['lifecycle']
    archived: boolean
    connected: boolean
    generationCurrent: boolean
  }>
): DirectSessionHandoffMode {
  if (input.archived || TERMINAL_SESSION_LIFECYCLES.includes(input.lifecycle))
    return 'one_time_review'
  if (!input.connected || !input.generationCurrent) return 'attached'
  return input.authority === 'chat' ? 'coordination_handoff' : 'attached'
}

export type DirectSessionHandoffSupply = Readonly<{
  harnessRuns?: readonly HarnessRun[]
  mode?: DirectSessionHandoffMode
  controlConflict?: boolean
}>

/**
 * Production supplier: builds the handoff input from one canonical
 * `ChatConversation` plus surface facts. The run candidate is resolved by
 * the register binding (`activeHarnessRunId`) and never guessed; the draft
 * flag reads the live conversation draft; an explicit mode (e.g. the
 * confirmed post-transfer `returned_to_user`) overrides derivation.
 */
export function deriveHandoffInputFromConversation(
  input: Readonly<{
    conversation: ChatConversation
    authority: HandoffSurfaceAuthority
    connected: boolean
    generationCurrent?: boolean
    scopeAuthorized?: boolean
    harnessRuns?: readonly HarnessRun[]
    awaitingApproval?: boolean
    mode?: DirectSessionHandoffMode
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
  const mode =
    input.mode ??
    (staleView || !generationCurrent
      ? 'attached'
      : deriveHandoffModeForSurface({
          authority: input.authority,
          lifecycle,
          archived: input.conversation.archived,
          connected: input.connected,
          generationCurrent,
        }))
  return {
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
    inputOwnedHere: input.authority === 'chat',
    hasUnsentDraft:
      input.conversation.draft.trim().length > 0 || input.conversation.draftBlocks.length > 0,
    controlConflict: input.controlConflict ?? false,
    awaitingApproval: input.awaitingApproval ?? false,
  }
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
