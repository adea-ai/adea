// Target-aware handoff observation, child-job controls, and truthful activity
// summary (#1177). Pure and component-free, like `handoff.ts`.
//
// Control over a handed-off session is never granted by a supplied session
// id, a running lead, or a caller-claimed generation. It exists only where an
// AUTHENTICATED runtime observation names the target session, task,
// independently observed generation, and the owning intent/attempt, and all of
// them agree with the claim and the live session at once. Every disagreement
// is named by its own code so the surface can say which proof is missing.
//
// No producer of this observation exists yet (control-plane#935 carries the
// target end to end). This module is the consumer contract: with no
// observation supplied every target-aware control stays unavailable and says
// why, and the presentation completes the moment a producer lands.
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'
import {
  isRetainedChildFailureCode,
  isRetainedChildRole,
  retainedChildUnknownRole,
} from '@adea-ai/types'

/**
 * An observation of where a handed-off turn actually executes. Only
 * `runtime_authenticated` provenance can bind: a control-plane-reported or
 * caller-supplied observation is display-only and never reaches this type.
 */
export type HandoffTargetObservation = Readonly<{
  source: 'runtime_authenticated'
  sessionId: string
  taskId: string
  /** The target's generation as the runtime observed it, independent of the claim. */
  generation: number
  /** Owning lead-turn intent. */
  intentId: string
  /** Owning admitted execution attempt (control-plane `attemptId`, not the dispatch id). */
  attemptId: string
}>

export type HandoffObservationFailure =
  | 'absent'
  | 'unauthenticated'
  | 'session'
  | 'task'
  | 'generation'
  | 'intent'
  | 'attempt'

export type HandoffObservationBinding =
  | Readonly<{ bound: true }>
  | Readonly<{ bound: false; code: HandoffObservationFailure; reason: string }>

/** What the claim and the live session say the observation must match. */
export type HandoffObservationExpectation = Readonly<{
  sessionId: string
  /** Task named by the retained claim; a claim without a task never binds. */
  taskId: string | undefined
  /** The live session generation. */
  generation: number
  /** Owning intent of the lead turn. */
  intentId: string
  /** Admitted execution attempt of the lead turn; undefined until admitted. */
  attemptId: string | undefined
}>

const FAILURE_REASONS: Readonly<Record<HandoffObservationFailure, string>> = {
  absent:
    'No authenticated runtime observation binds this session, task, generation, and owning intent/attempt.',
  unauthenticated: 'The observation is not runtime-authenticated, so it can only be displayed.',
  session: 'The observation names a different session.',
  task: 'The observation names a different task than the retained request.',
  generation: 'The observation names a different generation than this session.',
  intent: 'The observation belongs to a different lead-turn intent.',
  attempt: 'The observation belongs to a different attempt than this turn’s execution.',
}

function failure(code: HandoffObservationFailure): HandoffObservationBinding {
  return { bound: false, code, reason: FAILURE_REASONS[code] }
}

/**
 * Binds one observation to the claim and live session. All five facts must
 * agree; the first disagreement is returned by code. A missing task or
 * attempt on the expectation fails closed (nothing to compare is not a match).
 */
export function bindTargetObservation(
  observation: HandoffTargetObservation | undefined,
  expected: HandoffObservationExpectation
): HandoffObservationBinding {
  if (observation === undefined) return failure('absent')
  if (observation.source !== 'runtime_authenticated') return failure('unauthenticated')
  if (observation.sessionId !== expected.sessionId) return failure('session')
  if (expected.taskId === undefined || observation.taskId !== expected.taskId)
    return failure('task')
  if (observation.generation !== expected.generation) return failure('generation')
  if (observation.intentId !== expected.intentId) return failure('intent')
  if (expected.attemptId === undefined || observation.attemptId !== expected.attemptId)
    return failure('attempt')
  return { bound: true }
}

// ── Child jobs and descendants ──────────────────────────────────────────────

export type HandoffChildJobState =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'cancel_pending'
  | 'cancelled'
  | 'completed'
  | 'failed'

/**
 * One observed child job of the coordinating turn. Its own observation must
 * bind to the SAME target as the coordination binding: a job observed under
 * another session, task, generation, or attempt is never cancellable here.
 */
export type HandoffChildJob = Readonly<{
  jobId: string
  label: string
  state: HandoffChildJobState
  /** Descendants beneath this job, as observed (0 when none). */
  descendantCount: number
  observation: HandoffTargetObservation
}>

export type HandoffChildControlKind = 'job_cancel' | 'descendant_cancel'

export type HandoffChildJobRow = Readonly<{
  jobId: string
  label: string
  state: HandoffChildJobState
  descendantCount: number
  job: Readonly<{ available: boolean; reason?: string }>
  descendants: Readonly<{ available: boolean; reason?: string }>
}>

const CANCELLABLE_JOB_STATES: readonly HandoffChildJobState[] = [
  'queued',
  'running',
  'awaiting_input',
]

/**
 * Derives one row per observed child job. Cancelling a job or its
 * descendants is separate from stopping the lead, and enabled only when ALL
 * hold: the coordination binding is established, the job's own observation
 * binds to the same target, the job is still cancellable, and the host
 * supplied a cancel path (the control-plane cancel-intent contract). A
 * pending cancel stays pending until the runtime confirms it; it is never
 * shown as done and cannot be requested twice.
 */
export function deriveChildJobRows(
  input: Readonly<{
    jobs: readonly HandoffChildJob[]
    coordinationBound: boolean
    expected: HandoffObservationExpectation
    cancelWired: boolean
  }>
): readonly HandoffChildJobRow[] {
  return input.jobs.map((job) => {
    const unavailable = ((): string | undefined => {
      if (!input.coordinationBound)
        return 'Unavailable until an authenticated observation binds this session, task, generation, and owning intent/attempt.'
      const binding = bindTargetObservation(job.observation, input.expected)
      if (!binding.bound) return binding.reason
      if (job.state === 'cancel_pending')
        return 'A cancellation is already pending; it stays pending until the runtime confirms it.'
      if (!CANCELLABLE_JOB_STATES.includes(job.state))
        return `The job is ${job.state.replaceAll('_', ' ')}; there is nothing to cancel.`
      if (!input.cancelWired)
        return 'Unavailable: durable job cancellation needs the control-plane cancel-intent contract (control-plane issue 935).'
      return undefined
    })()
    const jobControl =
      unavailable === undefined ? { available: true } : { available: false, reason: unavailable }
    const descendants =
      unavailable !== undefined
        ? { available: false, reason: unavailable }
        : job.descendantCount === 0
          ? { available: false, reason: 'This job has no observed descendants.' }
          : { available: true }
    return {
      jobId: job.jobId,
      label: job.label,
      state: job.state,
      descendantCount: job.descendantCount,
      job: jobControl,
      descendants,
    }
  })
}

// ── Activity: raw observed events (not current state) ──────────────────────

export type HandoffActivity = Readonly<{
  /** Raw `approval.requested` events in the retained window. Not a pending
   *  count: events carry no qualified identity here, so a resolution cannot
   *  be matched to its request. */
  approvalRequestedEvents: number
  /** Raw `approval.resolved` / `approval.expired` events in the window. */
  approvalClosedEvents: number
  /** Last event in the retained window, for "last activity" truth. */
  lastEvent?: Readonly<{ kind: string; seq: string; occurredAt: string }>
  /** `file.observed` events in the retained window (artifact evidence). */
  filesObserved: number
  /** `subagent.observed` events in the retained window. Observation, never control. */
  subagentsObserved: number
  /** Raw `capability.degraded` / `capability.restored` events in the window. */
  capabilityDegradedEvents: number
  capabilityRestoredEvents: number
  /** Always false until an identity-keyed contract exists: which approvals
   *  are open and which capabilities are currently degraded is NOT known
   *  from these counts. The surface labels them as raw observed events. */
  activeStateKnown: false
  /** True when the retained window is complete; counts are lower bounds otherwise. */
  windowComplete: boolean
  /** Structured projections report approvals/progress; a terminal fallback does not. */
  structured: boolean
}>

/**
 * Counts the raw events the retained window contains. It does not infer
 * current state: approval and capability events carry no qualified identity
 * in this contract, so a resolution may belong to a different request and
 * repeated degradation says nothing about how many capabilities are degraded
 * now. Counts are lower bounds when the window is incomplete, and a
 * terminal-fallback projection reports no structured approval events at all.
 * Payloads are never read.
 */
export function deriveHandoffActivity(
  input: Readonly<{
    events: readonly Pick<RuntimeEvent, 'kind' | 'seq' | 'occurredAt'>[]
    projection: 'structured' | 'authenticated_hook' | 'terminal_fallback'
    windowComplete: boolean
  }>
): HandoffActivity {
  const structured = input.projection !== 'terminal_fallback'
  let requested = 0
  let closed = 0
  let files = 0
  let subagents = 0
  let degraded = 0
  let restored = 0
  for (const event of input.events) {
    switch (event.kind) {
      case 'approval.requested':
        requested += 1
        break
      case 'approval.resolved':
      case 'approval.expired':
        closed += 1
        break
      case 'file.observed':
        files += 1
        break
      case 'subagent.observed':
        subagents += 1
        break
      case 'capability.degraded':
        degraded += 1
        break
      case 'capability.restored':
        restored += 1
        break
      default:
        break
    }
  }
  const last = input.events.at(-1)
  return {
    approvalRequestedEvents: structured ? requested : 0,
    approvalClosedEvents: structured ? closed : 0,
    ...(last === undefined
      ? {}
      : { lastEvent: { kind: last.kind, seq: last.seq, occurredAt: last.occurredAt } }),
    filesObserved: files,
    subagentsObserved: subagents,
    capabilityDegradedEvents: degraded,
    capabilityRestoredEvents: restored,
    activeStateKnown: false,
    windowComplete: input.windowComplete,
    structured,
  }
}

// ── Control-plane child observations (#1173) ───────────────────────────────
//
// The lead-turn children read (control-plane `getPiDurableLeadChildren`) is a
// per-read snapshot reported by the control plane. It is DISPLAY-ONLY: it is
// not a runtime-authenticated observation, carries no generation, and so can
// never bind a cancel. It exists to show the person which children the lead
// has delegated to, and to say plainly what the read did not prove: that it
// was unavailable, or that it is a partial page.

export type HandoffObservedChildState =
  | 'requested'
  | 'dispatched'
  | 'running'
  | 'awaiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'manual_intervention'

export type HandoffObservedChild = Readonly<{
  delegationId: string
  role: string
  state: HandoffObservedChildState
  awaitingInput: boolean
  stopRequested: boolean
  updatedAt: string
  outcome?: Readonly<{
    state: 'completed' | 'failed' | 'cancelled'
    failureCode?: string
    publication: 'pending' | 'published'
  }>
}>

export type HandoffChildUnavailableCode =
  | 'NOT_DISPATCHED'
  | 'ADMISSION_SERVICE_UNAVAILABLE'
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_RESPONSE_INVALID'

/** What the children read returned: one page, or an unavailable read that
 *  carries no empty set, count, or completion claim. */
export type HandoffChildObservations =
  | Readonly<{
      availability: 'available'
      children: readonly HandoffObservedChild[]
      totalChildren: number
      complete: boolean
    }>
  | Readonly<{ availability: 'unavailable'; reasonCode: HandoffChildUnavailableCode }>

const UNAVAILABLE_REASONS: Readonly<Record<HandoffChildUnavailableCode, string>> = {
  NOT_DISPATCHED: 'The lead turn has not been dispatched, so it has no children to report.',
  ADMISSION_SERVICE_UNAVAILABLE: 'The control plane could not be reached, so children are unknown.',
  RUNTIME_UNAVAILABLE: 'The runtime could not be reached, so children are unknown.',
  RUNTIME_RESPONSE_INVALID: 'The control plane returned a response that was not usable.',
}

export type HandoffChildEvidenceRow = Readonly<{
  delegationId: string
  role: string
  /** State words exactly as reported, plus qualifiers that are claims, not facts. */
  stateText: string
  qualifiers: readonly string[]
  updatedAt: string
}>

export type HandoffChildEvidence =
  /** No children read was supplied to this view. */
  | Readonly<{ kind: 'not_connected'; summary: string }>
  | Readonly<{ kind: 'unavailable'; summary: string }>
  /** A complete read with no children. */
  | Readonly<{ kind: 'none'; summary: string }>
  | Readonly<{
      kind: 'complete' | 'partial'
      summary: string
      rows: readonly HandoffChildEvidenceRow[]
      totalChildren: number
    }>

function stateText(child: HandoffObservedChild): string {
  return child.state.replaceAll('_', ' ')
}

function qualifiersOf(child: HandoffObservedChild): readonly string[] {
  const qualifiers: string[] = []
  if (child.awaitingInput && child.state !== 'awaiting_input') qualifiers.push('awaiting input')
  if (child.stopRequested) qualifiers.push('stop requested, not confirmed')
  if (child.outcome !== undefined) {
    qualifiers.push(
      child.outcome.publication === 'pending'
        ? 'control plane outcome publication pending'
        : 'control plane outcome published'
    )
    // A control-plane failure code is shown only when it is a bounded value.
    // The surface reports what the control plane said; it does not repeat an
    // unbounded or control-bearing string it cannot vouch for.
    if (
      child.outcome.failureCode !== undefined &&
      isRetainedChildFailureCode(child.outcome.failureCode)
    )
      qualifiers.push(`failure code ${child.outcome.failureCode}`)
  }
  return qualifiers
}

/**
 * Turns a children read into what the surface may say. Unknown stays
 * unknown: an unsupplied or unavailable read never reads as "no children",
 * and an incomplete page names how many children it did not show.
 */
export function deriveChildEvidence(
  observations: HandoffChildObservations | undefined
): HandoffChildEvidence {
  if (observations === undefined)
    return {
      kind: 'not_connected',
      summary: 'Child delegations are not connected to this view, so they are not shown.',
    }
  if (observations.availability === 'unavailable')
    return { kind: 'unavailable', summary: UNAVAILABLE_REASONS[observations.reasonCode] }
  const rows = observations.children.map((child) => ({
    delegationId: child.delegationId,
    role: isRetainedChildRole(child.role) ? child.role : retainedChildUnknownRole,
    stateText: stateText(child),
    qualifiers: qualifiersOf(child),
    updatedAt: child.updatedAt,
  }))
  // `complete` says the read reached its last page, not that this page holds every child:
  // a final cursor page can be complete with earlier children on pages not shown here.
  const hidden = Math.max(observations.totalChildren - rows.length, 0)
  if (observations.complete && rows.length === 0 && observations.totalChildren === 0)
    return { kind: 'none', summary: 'The control plane reports no child delegations.' }
  if (!observations.complete || hidden > 0)
    return {
      kind: 'partial',
      summary:
        hidden === 0
          ? `Showing ${rows.length} children; the list is not complete.`
          : observations.complete
            ? `This is the last page of the read: showing ${rows.length} of ${observations.totalChildren} children; ${hidden} on earlier pages not shown.`
            : `Showing ${rows.length} of ${observations.totalChildren} children; ${hidden} not shown.`,
      rows,
      totalChildren: observations.totalChildren,
    }
  return {
    kind: 'complete',
    summary: `${rows.length} ${rows.length === 1 ? 'child' : 'children'} reported.`,
    rows,
    totalChildren: observations.totalChildren,
  }
}
