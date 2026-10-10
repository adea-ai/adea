import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { withAuthorizedLeadTurn } from './lead-turns'
import { leadTurnIntents } from './schema/lead-turns'
import { leadTurnRuntime } from './schema/lead-turn-runtime'

// Rollback readers and uncertain-effect fencing for lead turns (M18.01.3, #1220).
//
// The fence is an admission-level flag. It is set once, before a rollback routes new work away
// from the Pi path, and it stops this path from preparing or dispatching the same admission again.
// Observation, binding recovery, cancellation and publication of an already-recorded result stay
// available, because they reconcile evidence rather than create a new effect. Fencing never
// rewrites state, dispatch identity, runtime session or publication evidence.
//
// Fail closed: a non-terminal admission that is not fenced is `fence_required`, and an observed row
// that does not match a known evidence shape is `blocked_unclassifiable`. Neither is ever read as
// safe to resume or reroute.

export type LeadTurnRollbackDisposition =
  /** Not fenced yet and not terminal: the fence must be applied before any routing decision. */
  | 'fence_required'
  /** Fenced, and no dispatch was requested: the admission is not yet owned by any runtime. */
  | 'no_effect_recorded'
  /** Fenced, and a dispatch may exist without an observed outcome. Reconcile before any resume. */
  | 'reconcile_uncertain_effect'
  /** Fenced, and a runtime session was observed as active. The owner is the runtime, not a reroute. */
  | 'in_flight_fenced'
  /** Terminal outcome retained as history. Nothing resumes from it. */
  | 'terminal_retained'
  /** Evidence does not match a known shape. Preserved as-is and never resumed. */
  | 'blocked_unclassifiable'

export type LeadTurnRollbackEvidence = Readonly<{
  fenced: boolean
  runtime?: Readonly<{
    state: string
    dispatchId: string | null
    runtimeSessionId: string | null
    observedAt: Date | null
  }>
}>

const terminalStates = ['cancelled', 'completed', 'failed', 'timed_out']
const inFlightStates = ['awaiting_input', 'cancelling', 'running', 'starting']
const uncertainStates = ['dispatch_pending', 'unknown']

/** Pure classification of retained evidence. Performs no I/O and never changes evidence. */
export function classifyLeadTurnRollback(
  evidence: LeadTurnRollbackEvidence
): LeadTurnRollbackDisposition {
  const runtime = evidence.runtime
  if (!runtime) return evidence.fenced ? 'no_effect_recorded' : 'fence_required'
  if (terminalStates.includes(runtime.state)) return 'terminal_retained'
  if (!evidence.fenced) return 'fence_required'
  if (runtime.state === 'prepared') {
    return runtime.dispatchId === null && runtime.runtimeSessionId === null
      ? 'no_effect_recorded'
      : 'blocked_unclassifiable'
  }
  if (uncertainStates.includes(runtime.state)) return 'reconcile_uncertain_effect'
  if (inFlightStates.includes(runtime.state)) {
    return runtime.dispatchId !== null &&
      runtime.runtimeSessionId !== null &&
      runtime.observedAt !== null
      ? 'in_flight_fenced'
      : 'blocked_unclassifiable'
  }
  return 'blocked_unclassifiable'
}

/**
 * Serializes new effects against the rollback fence. Callers that prepare or dispatch lock the
 * intent before the runtime row, the same order the fence uses, so a concurrent fence is either
 * fully visible to the check or waits for the dispatch to finish.
 */
export async function assertLeadTurnNotFenced(
  tx: AgentHqTransaction,
  intentId: string,
  mode: 'share' | 'update' = 'update'
) {
  const [intent] = await tx
    .select({ rollbackFencedAt: leadTurnIntents.rollbackFencedAt })
    .from(leadTurnIntents)
    .where(eq(leadTurnIntents.id, intentId))
    .for(mode)
  if (!intent || intent.rollbackFencedAt) throw new Error('LEAD_TURN_FENCED')
}

export type LeadTurnRollbackFence = Readonly<{
  intentId: string
  disposition: LeadTurnRollbackDisposition
  fenced: boolean
  rollbackFencedAt?: string
}>

/**
 * Trusted rollback boundary, called by server rollback tooling and never by a user principal.
 * Applies the fence to a non-terminal admission and returns the classification of the evidence
 * that now exists. Repeated calls keep the first fence time. Terminal admissions are not written.
 */
export function fenceLeadTurnForRollback(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string
): Promise<LeadTurnRollbackFence> {
  return database.transaction(async (tx) => {
    const [intent] = await tx
      .select({ id: leadTurnIntents.id, rollbackFencedAt: leadTurnIntents.rollbackFencedAt })
      .from(leadTurnIntents)
      .where(and(eq(leadTurnIntents.id, intentId), eq(leadTurnIntents.workspaceId, workspaceId)))
      .for('update')
    if (!intent) throw new Error('Lead turn unavailable')
    const [row] = await tx
      .select()
      .from(leadTurnRuntime)
      .where(eq(leadTurnRuntime.intentId, intentId))
      .for('update')
    if (row && terminalStates.includes(row.state)) {
      const fenced = intent.rollbackFencedAt !== null
      return {
        intentId,
        disposition: classifyLeadTurnRollback({ fenced, runtime: row }),
        fenced,
        ...(intent.rollbackFencedAt
          ? { rollbackFencedAt: intent.rollbackFencedAt.toISOString() }
          : {}),
      }
    }
    let fencedAt = intent.rollbackFencedAt
    if (!fencedAt) {
      const [updated] = await tx
        .update(leadTurnIntents)
        .set({ rollbackFencedAt: new Date() })
        .where(eq(leadTurnIntents.id, intentId))
        .returning({ rollbackFencedAt: leadTurnIntents.rollbackFencedAt })
      fencedAt = updated?.rollbackFencedAt ?? null
    }
    if (!fencedAt) throw new Error('Lead turn unavailable')
    return {
      intentId,
      disposition: classifyLeadTurnRollback({ fenced: true, runtime: row }),
      fenced: true,
      rollbackFencedAt: fencedAt.toISOString(),
    }
  })
}

export type LeadTurnRollbackState = Readonly<{
  intentId: string
  messageId: string
  disposition: LeadTurnRollbackDisposition
  fenced: boolean
  rollbackFencedAt?: string
  runtime?: Readonly<{
    state: string
    executionId: string
    attemptId: string
    dispatchId?: string
    runtimeSessionId?: string
    observedAt?: string
    publishedMessageId?: string
  }>
}>

/**
 * Rollback reader for the admitted actor or an authorized participant. It reads retained evidence
 * through the same live authority as every other lead-turn reader, so a denied user gets the same
 * unavailable answer and learns nothing about the fence.
 */
export function readLeadTurnRollbackState(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef
): Promise<LeadTurnRollbackState> {
  return withAuthorizedLeadTurn(
    database,
    workspaceId,
    intentId,
    principal,
    false,
    async (tx, intent) => {
      const [row] = await tx
        .select()
        .from(leadTurnRuntime)
        .where(eq(leadTurnRuntime.intentId, intent.id))
      const fenced = intent.rollbackFencedAt !== null
      const runtime = row
        ? {
            state: row.state,
            executionId: row.executionId,
            attemptId: row.attemptId,
            ...(row.dispatchId ? { dispatchId: row.dispatchId } : {}),
            ...(row.runtimeSessionId ? { runtimeSessionId: row.runtimeSessionId } : {}),
            ...(row.observedAt ? { observedAt: row.observedAt.toISOString() } : {}),
            ...(row.publishedMessageId ? { publishedMessageId: row.publishedMessageId } : {}),
          }
        : undefined
      return {
        intentId: intent.id,
        messageId: intent.messageId,
        disposition: classifyLeadTurnRollback({ fenced, runtime: row }),
        fenced,
        ...(intent.rollbackFencedAt
          ? { rollbackFencedAt: intent.rollbackFencedAt.toISOString() }
          : {}),
        ...(runtime ? { runtime } : {}),
      }
    }
  )
}
