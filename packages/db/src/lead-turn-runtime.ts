import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type {
  GroupCompletedJob,
  GroupPublicationDecision,
  GroupPublicationHoldReason,
  UserPrincipalRef,
} from '@adea-ai/types'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { bindAddressedTurnResponse } from './addressed-turn-response-binding'
import { createRuntimeResultMessage } from './conversations'
import { parseRequestedRoleModelSelections } from './lead-model-selections'
import { assertLeadTurnNotFenced } from './lead-turn-rollback'
import { withAuthorizedLeadTurn, withHistoricalLeadTurn } from './lead-turns'
import { decideGroupPublication } from './group-participation-policy'
import {
  admissionForParticipant,
  loadGroupRoster,
  type GroupStoreDatabase,
} from './group-participation-store'
import { addressedAgentTurns } from './schema/addressed-agent-turns'
import { channels } from './schema/conversations'
import { leadTurnRuntime } from './schema/lead-turn-runtime'
import { leadTurnIntents } from './schema/lead-turns'

/** What the accepted lead plan holds back for child executions, as the control plane disclosed it. */
export type LeadTurnChildAllowance = Readonly<
  | {
      state: 'stated'
      executionPlanDigest: string
      currency: 'USD'
      maximumMicrounits: number
      maximumTokens: number
    }
  | { state: 'not_stated'; executionPlanDigest: string }
>
export type LeadTurnAcceptedSelection = Readonly<{
  workspaceId: string
  intentId: string
  executionId: string
  attemptId: string
  selectionRef: string
  selectionRevision: number
  preparationRef: string
  expiresAt: string
  /** Absent when the control plane predates the disclosure; absence is not `not_stated`. */
  childAllowance?: LeadTurnChildAllowance
}>
export type LeadTurnRuntimeBinding = Readonly<{
  intentId: string
  dispatchId: string
  executionId: string
  attemptId: string
  runtimeSessionId: string
}>
export type LeadTurnObservedState =
  | 'starting'
  | 'running'
  | 'awaiting_input'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'unknown'
type Row = typeof leadTurnRuntime.$inferSelect
const terminal = (state: string) =>
  ['completed', 'failed', 'cancelled', 'timed_out'].includes(state)
function childAllowanceOf(row: Row): LeadTurnChildAllowance {
  if (row.childAllowanceState === 'stated') {
    if (
      row.childAllowancePlanDigest === null ||
      row.childAllowanceMaximumMicrounits === null ||
      row.childAllowanceMaximumTokens === null
    )
      throw new Error('RUNTIME_RESPONSE_INVALID')
    return {
      state: 'stated',
      executionPlanDigest: row.childAllowancePlanDigest,
      currency: 'USD',
      maximumMicrounits: row.childAllowanceMaximumMicrounits,
      maximumTokens: row.childAllowanceMaximumTokens,
    }
  }
  if (row.childAllowanceState !== 'not_stated' || row.childAllowancePlanDigest === null)
    throw new Error('RUNTIME_RESPONSE_INVALID')
  return { state: 'not_stated', executionPlanDigest: row.childAllowancePlanDigest }
}
function summary(row: Row, messageId: string) {
  return {
    intentId: row.intentId,
    messageId,
    state: row.state as 'prepared' | 'dispatch_pending' | LeadTurnObservedState,
    executionId: row.executionId,
    attemptId: row.attemptId,
    selectionRef: row.selectionRef,
    selectionRevision: row.selectionRevision,
    preparationRef: row.preparationRef,
    preparationExpiresAt: row.preparationExpiresAt.toISOString(),
    ...(row.childAllowanceState ? { childAllowance: childAllowanceOf(row) } : {}),
    ...(row.dispatchId ? { dispatchId: row.dispatchId } : {}),
    ...(row.runtimeSessionId ? { runtimeSessionId: row.runtimeSessionId } : {}),
    ...(row.observedAt ? { observedAt: row.observedAt.toISOString() } : {}),
    ...(row.cancelRequestedAt ? { cancelRequestedAt: row.cancelRequestedAt.toISOString() } : {}),
    ...(row.publishedMessageId ? { publishedMessageId: row.publishedMessageId } : {}),
  }
}
function assertBinding(row: Row, value: LeadTurnRuntimeBinding) {
  if (
    row.intentId !== value.intentId ||
    row.executionId !== value.executionId ||
    row.attemptId !== value.attemptId ||
    (row.dispatchId !== null && row.dispatchId !== value.dispatchId) ||
    (row.runtimeSessionId !== null && row.runtimeSessionId !== value.runtimeSessionId)
  )
    throw new Error('RUNTIME_RESPONSE_INVALID')
}
/**
 * `read` observes or reconciles an existing admission, and archived history stays available.
 * `cancel` is the original actor's cancellation, with the same archived-history access. `effect`
 * admits new work, so it stays active-only and fence-gated (prepare, dispatch, funding).
 */
export type LeadTurnAuthorityPurpose = 'cancel' | 'effect' | 'read'

export function resolveLeadTurnAuthority(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef,
  purpose: LeadTurnAuthorityPurpose = 'read'
) {
  const authority = (
    intent: typeof leadTurnIntents.$inferSelect,
    controlPlaneWorkspaceId: string
  ) => ({
    intentId: intent.id,
    messageId: intent.messageId,
    workspaceId,
    controlPlaneWorkspaceId,
    originalActorRef: `user:${intent.actorUserId}` as const,
    // Immutable column: every process that reads this intent derives the same instant.
    admittedAt: intent.createdAt.toISOString(),
    ...(intent.handoffTargetSessionId !== null && intent.handoffTargetGeneration !== null
      ? {
          handoffTarget: {
            runtimeSessionId: intent.handoffTargetSessionId,
            ...(intent.handoffTargetTaskId !== null ? { taskId: intent.handoffTargetTaskId } : {}),
            observedGeneration: intent.handoffTargetGeneration,
          },
        }
      : {}),
    // Absent means the workspace lead default; a present reference is the exact immutable choice.
    requestedLeadSelection:
      parseRequestedRoleModelSelections(intent.requestedModelSelections ?? undefined)?.lead ?? null,
  })
  return purpose === 'effect'
    ? withAuthorizedLeadTurn(
        database,
        workspaceId,
        intentId,
        principal,
        true,
        async (tx, intent, _message, cpWorkspaceId) => {
          // Refuse a fenced admission here, before the runtime is called. Otherwise adapter.prepare runs
          // before store.prepare reaches the fence check.
          await assertLeadTurnNotFenced(tx, intent.id, 'share')
          return authority(intent, cpWorkspaceId)
        }
      )
    : withHistoricalLeadTurn(
        database,
        workspaceId,
        intentId,
        principal,
        purpose,
        async (_tx, intent, _message, cpWorkspaceId) => authority(intent, cpWorkspaceId)
      )
}
async function readStoredRuntime(
  tx: AgentHqTransaction,
  intent: { id: string; messageId: string }
) {
  const [row] = await tx
    .select()
    .from(leadTurnRuntime)
    .where(eq(leadTurnRuntime.intentId, intent.id))
  return row ? summary(row, intent.messageId) : undefined
}

/**
 * Stored runtime row. `read` is the default direct-only historical access. A mutation purpose is
 * for the runtime operation that has itself authorized it: `cancel` for the claim holder's active
 * group cancellation, or `effect` for the actor's prepare and dispatch. Each keeps its own
 * boundary check; no other purpose reaches a group.
 */
export function readLeadTurnRuntime(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef,
  purpose: LeadTurnAuthorityPurpose = 'read'
) {
  return purpose === 'effect'
    ? withAuthorizedLeadTurn(database, workspaceId, intentId, principal, true, (tx, intent) =>
        readStoredRuntime(tx, intent)
      )
    : withHistoricalLeadTurn(database, workspaceId, intentId, principal, purpose, (tx, intent) =>
        readStoredRuntime(tx, intent)
      )
}
/** Caller identifiers are selectors only; exact accepted product authority is resolved server-side. */
export async function authorizeLeadTurnFundingBinding(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  binding: Pick<
    LeadTurnAcceptedSelection,
    'executionId' | 'attemptId' | 'selectionRef' | 'selectionRevision'
  >
) {
  const [retained] = await database
    .select({ intentId: leadTurnRuntime.intentId })
    .from(leadTurnRuntime)
    .where(
      and(
        eq(leadTurnRuntime.executionId, binding.executionId),
        eq(leadTurnRuntime.attemptId, binding.attemptId),
        eq(leadTurnRuntime.selectionRef, binding.selectionRef),
        eq(leadTurnRuntime.selectionRevision, binding.selectionRevision)
      )
    )
  if (!retained) return false
  try {
    return await withAuthorizedLeadTurn(
      database,
      workspaceId,
      retained.intentId,
      principal,
      true,
      async (tx, intent) => {
        await assertLeadTurnNotFenced(tx, intent.id, 'share')
        const [current] = await tx
          .select()
          .from(leadTurnRuntime)
          .where(eq(leadTurnRuntime.intentId, intent.id))
          .for('share')
        return Boolean(
          current &&
          current.executionId === binding.executionId &&
          current.attemptId === binding.attemptId &&
          current.selectionRef === binding.selectionRef &&
          current.selectionRevision === binding.selectionRevision
        )
      }
    )
  } catch {
    return false
  }
}
function childAllowanceColumns(value: LeadTurnChildAllowance | undefined) {
  if (value === undefined)
    return {
      childAllowanceState: null,
      childAllowancePlanDigest: null,
      childAllowanceMaximumMicrounits: null,
      childAllowanceMaximumTokens: null,
    }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.executionPlanDigest))
    throw new Error('RUNTIME_RESPONSE_INVALID')
  if (value.state === 'not_stated')
    return {
      childAllowanceState: 'not_stated',
      childAllowancePlanDigest: value.executionPlanDigest,
      childAllowanceMaximumMicrounits: null,
      childAllowanceMaximumTokens: null,
    }
  if (
    value.currency !== 'USD' ||
    !Number.isSafeInteger(value.maximumMicrounits) ||
    value.maximumMicrounits < 0 ||
    !Number.isSafeInteger(value.maximumTokens) ||
    value.maximumTokens < 0
  )
    throw new Error('RUNTIME_RESPONSE_INVALID')
  return {
    childAllowanceState: 'stated',
    childAllowancePlanDigest: value.executionPlanDigest,
    childAllowanceMaximumMicrounits: value.maximumMicrounits,
    childAllowanceMaximumTokens: value.maximumTokens,
  }
}
export function prepareLeadTurnRuntime(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef,
  selection: LeadTurnAcceptedSelection
) {
  return withAuthorizedLeadTurn(
    database,
    workspaceId,
    intentId,
    principal,
    true,
    async (tx, intent, _message, cpWorkspaceId) => {
      await assertLeadTurnNotFenced(tx, intent.id)
      if (
        selection.workspaceId !== cpWorkspaceId ||
        selection.intentId !== intentId ||
        !Number.isSafeInteger(selection.selectionRevision) ||
        selection.selectionRevision < 1 ||
        !/^prep_[a-f0-9]{32}$/.test(selection.preparationRef) ||
        !Number.isFinite(Date.parse(selection.expiresAt)) ||
        Date.parse(selection.expiresAt) <= Date.now()
      )
        throw new Error('RUNTIME_RESPONSE_INVALID')
      await tx
        .insert(leadTurnRuntime)
        .values({
          intentId: intent.id,
          executionId: selection.executionId,
          attemptId: selection.attemptId,
          selectionRef: selection.selectionRef,
          selectionRevision: selection.selectionRevision,
          preparationRef: selection.preparationRef,
          preparationExpiresAt: new Date(selection.expiresAt),
          ...childAllowanceColumns(selection.childAllowance),
        })
        .onConflictDoNothing()
      const [row] = await tx
        .select()
        .from(leadTurnRuntime)
        .where(eq(leadTurnRuntime.intentId, intent.id))
        .for('update')
      if (
        !row ||
        row.executionId !== selection.executionId ||
        row.attemptId !== selection.attemptId ||
        row.selectionRef !== selection.selectionRef ||
        row.selectionRevision !== selection.selectionRevision ||
        row.preparationRef !== selection.preparationRef ||
        row.preparationExpiresAt.getTime() !== Date.parse(selection.expiresAt)
      )
        throw new Error('RUNTIME_RESPONSE_INVALID')
    }
  )
}
export function markLeadTurnDispatchPending(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef,
  selection: LeadTurnAcceptedSelection
) {
  return withAuthorizedLeadTurn(
    database,
    workspaceId,
    intentId,
    principal,
    true,
    async (tx, intent) => {
      await assertLeadTurnNotFenced(tx, intent.id)
      const [row] = await tx
        .select()
        .from(leadTurnRuntime)
        .where(eq(leadTurnRuntime.intentId, intent.id))
        .for('update')
      if (
        !row ||
        row.executionId !== selection.executionId ||
        row.attemptId !== selection.attemptId ||
        row.selectionRef !== selection.selectionRef ||
        row.selectionRevision !== selection.selectionRevision ||
        row.preparationRef !== selection.preparationRef ||
        row.preparationExpiresAt.getTime() !== Date.parse(selection.expiresAt)
      )
        throw new Error('RUNTIME_RESPONSE_INVALID')
      if (row.preparationExpiresAt.getTime() <= Date.now())
        throw new Error('RUNTIME_RESPONSE_INVALID')
      if (row.state === 'prepared')
        await tx
          .update(leadTurnRuntime)
          .set({ state: 'dispatch_pending' })
          .where(eq(leadTurnRuntime.intentId, intent.id))
    }
  )
}
export function observeLeadTurnRuntime(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef,
  observation: LeadTurnRuntimeBinding &
    Readonly<{ state: LeadTurnObservedState; observedAt: string }>
) {
  return withHistoricalLeadTurn(
    database,
    workspaceId,
    intentId,
    principal,
    'bind',
    async (tx, intent) => {
      const [row] = await tx
        .select()
        .from(leadTurnRuntime)
        .where(eq(leadTurnRuntime.intentId, intent.id))
        .for('update')
      if (!row) throw new Error('Lead turn unavailable')
      assertBinding(row, observation)
      if (terminal(row.state)) {
        if (terminal(observation.state) && row.state !== observation.state)
          throw new Error('RUNTIME_RESPONSE_INVALID')
        return summary(row, intent.messageId)
      }
      const [updated] = await tx
        .update(leadTurnRuntime)
        .set({
          state: observation.state,
          dispatchId: observation.dispatchId,
          runtimeSessionId: observation.runtimeSessionId,
          observedAt: new Date(observation.observedAt),
        })
        .where(eq(leadTurnRuntime.intentId, intent.id))
        .returning()
      if (!updated) throw new Error('Lead turn unavailable')
      return summary(updated, intent.messageId)
    }
  )
}
/** Receipt lookup supplies a real canonical session; it does not prove a running/terminal state. */
export function recoverLeadTurnRuntimeBinding(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef,
  binding: LeadTurnRuntimeBinding
) {
  return withHistoricalLeadTurn(
    database,
    workspaceId,
    intentId,
    principal,
    'bind',
    async (tx, intent) => {
      const [row] = await tx
        .select()
        .from(leadTurnRuntime)
        .where(eq(leadTurnRuntime.intentId, intent.id))
        .for('update')
      if (!row || (row.state !== 'dispatch_pending' && row.dispatchId === null))
        throw new Error('RUNTIME_RESPONSE_INVALID')
      assertBinding(row, binding)
      if (!row.dispatchId) {
        const [recovered] = await tx
          .update(leadTurnRuntime)
          .set({ dispatchId: binding.dispatchId, runtimeSessionId: binding.runtimeSessionId })
          .where(eq(leadTurnRuntime.intentId, intent.id))
          .returning()
        if (!recovered) throw new Error('Lead turn unavailable')
        return summary(recovered, intent.messageId)
      }
      return summary(row, intent.messageId)
    }
  )
}
export function requestLeadTurnCancellation(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef
) {
  return withHistoricalLeadTurn(
    database,
    workspaceId,
    intentId,
    principal,
    'cancel',
    async (tx, intent) => {
      const [row] = await tx
        .select()
        .from(leadTurnRuntime)
        .where(eq(leadTurnRuntime.intentId, intent.id))
        .for('update')
      if (!row?.dispatchId) throw new Error('Lead turn unavailable')
      if (!row.cancelRequestedAt)
        await tx
          .update(leadTurnRuntime)
          .set({ cancelRequestedAt: new Date() })
          .where(eq(leadTurnRuntime.intentId, intent.id))
    }
  )
}

/**
 * A held group publication, carrying the typed reason instead of failing silently.
 *
 * The hold keeps one result out of the group and says nothing about the
 * independently owned job, which is never cancelled, reassigned or denied by
 * it. The reason names the exact fence that refused the publication.
 */
export class GroupPublicationHoldError extends Error {
  readonly reason: GroupPublicationHoldReason

  constructor(reason: GroupPublicationHoldReason) {
    super(`Group publication held: ${reason}`)
    this.name = 'GroupPublicationHoldError'
    this.reason = reason
  }
}

/**
 * The frozen authorization of an addressed turn's late result: the exact
 * participation grant (id and revision) that admitted the work, together with
 * the group it was admitted in.
 */
type AddressedTurnPublication = Readonly<{
  channelId: string
  job: GroupCompletedJob
}>

/**
 * The addressed-turn claims that carry one lead-turn intent, and the exact
 * participation grant they agree on.
 *
 * `lead_turn_intents.message_id` is unique, so one intent serves every
 * dispatch attempt for one trigger message and Agent. The FIRST attempt mints
 * the intent and binds itself to it; a LATER attempt (a different dispatch
 * revision, which the claim key allows) reuses that same intent and binds
 * itself to it as well, so several claims can carry one intent. The claim
 * table has no unique or index over `intent_id` to settle it.
 *
 * The retained binding is therefore canonical only when EVERY such claim
 * agrees on the Agent and on the grant id and revision. A disagreement — a
 * legacy claim without a binding beside a bound one, or two different grant
 * revisions — leaves the authorizing grant unproven, and no row order can
 * settle it: the later claim may have reused work the earlier one admitted
 * under another revision. The binding is then carried as unproven and the
 * policy holds the late result exactly as it holds a missing binding.
 */
async function loadAddressedTurnPublication(
  database: GroupStoreDatabase,
  workspaceId: string,
  intentId: string
): Promise<AddressedTurnPublication | null> {
  const [intent] = await database
    .select({ agentId: leadTurnIntents.agentId, channelId: leadTurnIntents.channelId })
    .from(leadTurnIntents)
    .where(and(eq(leadTurnIntents.id, intentId), eq(leadTurnIntents.workspaceId, workspaceId)))
    .limit(1)
  if (!intent) return null
  // EVERY claim that carries the intent, never one of them: the binding is
  // canonical only when they all agree.
  const claims = await database
    .select()
    .from(addressedAgentTurns)
    .where(
      and(
        eq(addressedAgentTurns.workspaceId, workspaceId),
        eq(addressedAgentTurns.intentId, intentId)
      )
    )
  if (claims.length === 0) return null
  const [channel] = await database
    .select({ kind: channels.kind })
    .from(channels)
    .where(and(eq(channels.id, intent.channelId), eq(channels.workspaceId, workspaceId)))
    .limit(1)
  if (!channel || channel.kind !== 'group') return null
  const [runtime] = await database
    .select({ observedAt: leadTurnRuntime.observedAt })
    .from(leadTurnRuntime)
    .where(eq(leadTurnRuntime.intentId, intentId))
    .limit(1)
  const agreements = new Set(
    claims.map((claim) => JSON.stringify([claim.agentId, claim.authGrantId, claim.authRevision]))
  )
  const agreed = agreements.size === 1 ? claims[0] : undefined
  const authorization =
    agreed && agreed.authGrantId && agreed.authRevision !== null && agreed.authRevision > 0
      ? { groupId: intent.channelId, grantId: agreed.authGrantId, revision: agreed.authRevision }
      : null
  return {
    channelId: intent.channelId,
    job: {
      authorization,
      completedAt: runtime?.observedAt?.toISOString() ?? new Date().toISOString(),
      jobId: intentId,
      // The publisher is the Agent the intent itself pins, never whichever
      // claim happened to be read first.
      participant: { agentId: intent.agentId, kind: 'agent' },
    },
  }
}

/**
 * Group publication authority for an addressed turn's late result.
 *
 * The claim row RETAINS the exact participation grant (id and revision) that
 * admitted the work, and this decision compares that retained binding with the
 * addressed Agent's CURRENT admission. A remove-then-re-add issues a new,
 * higher revision on the same grant id, so the retained binding no longer
 * matches and the late result is HELD with `publication_binding_mismatch`
 * instead of publishing under authority the work never held.
 *
 * The decision never cancels the job and never transfers its authority: it
 * only keeps one result out of the group.
 */
async function decideAddressedTurnPublication(
  database: GroupStoreDatabase,
  workspaceId: string,
  bound: AddressedTurnPublication,
  now: string
): Promise<GroupPublicationDecision> {
  const roster = await loadGroupRoster(database, workspaceId, bound.channelId)
  return decideGroupPublication({
    admission: admissionForParticipant(roster, bound.job.participant),
    job: bound.job,
    now,
    publisher: bound.job.participant,
  })
}

/** A held publication throws the typed reason; a permitted publication continues. */
async function assertAddressedTurnPublication(
  database: GroupStoreDatabase,
  workspaceId: string,
  bound: AddressedTurnPublication,
  now: string
): Promise<void> {
  const decision = await decideAddressedTurnPublication(database, workspaceId, bound, now)
  if (decision.action !== 'publish') throw new GroupPublicationHoldError(decision.reason)
}

/**
 * Name the group fence behind a refused publication.
 *
 * The channel pin and the lead resolution refuse the same roster change the
 * group gate explains, and they run first inside the service transaction.
 * When the group gate also refuses, its typed reason is the one that says WHY
 * the work is no longer authorized, so it is reported instead of the generic
 * refusal. The gate never turns a refusal into an allow: when it permits, the
 * original failure stands, and a failure that is not about group authority at
 * all (a database error, a mismatched runtime binding) is never re-labelled.
 */
async function explainGroupPublicationHold(
  error: unknown,
  database: AgentHqDatabase,
  workspaceId: string,
  bound: AddressedTurnPublication | null
): Promise<unknown> {
  if (
    !bound ||
    !(error instanceof Error) ||
    error.name === 'GroupPublicationHoldError' ||
    (error.message !== 'Lead turn version conflict' && error.message !== 'Lead turn unavailable')
  )
    return error
  try {
    await assertAddressedTurnPublication(database, workspaceId, bound, new Date().toISOString())
  } catch (hold) {
    return hold
  }
  return error
}

/**
 * Bind the addressed turn's retained authorization and decide it against the
 * current roster, in one transaction that takes the canonical lock order
 * (CHANNEL before the roster's admissions and grants).
 *
 * This runs BEFORE the publication transaction so a superseded binding lands
 * as the typed group hold instead of the generic version conflict the
 * channel pin would raise for the same roster change.
 */
async function bindAndAuthorizeAddressedTurnPublication(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  now: string
): Promise<AddressedTurnPublication | null> {
  const claim = await loadAddressedTurnPublication(database, workspaceId, intentId)
  if (!claim) return null
  return database.transaction(async (transaction) => {
    await transaction
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, claim.channelId), eq(channels.workspaceId, workspaceId)))
      .limit(1)
      .for('update')
    await assertAddressedTurnPublication(transaction, workspaceId, claim, now)
    return claim
  })
}

/**
 * Terminal publication is distinct from execution. Raw progress can never call this boundary.
 * Publication appends a new Message, so it is an effect: it stays on the active-only effect gate,
 * and archived results remain unpublished (REQ 045).
 */
export async function publishLeadTurnResult(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  reader: UserPrincipalRef,
  binding: LeadTurnRuntimeBinding,
  bodyText: string,
  // Runs on the publication transaction with its canonical locks held, so it can read and
  // lock through that transaction; it must not check out another pool connection.
  assertCurrentGrant: (transaction: AgentHqTransaction) => Promise<void>
) {
  if (!bodyText.trim() || bodyText.length > 100_000 || typeof assertCurrentGrant !== 'function')
    throw new Error('PUBLICATION_WITHHELD')
  // The addressed turn's retained grant binding is decided BEFORE the service
  // transaction, so a remove-then-re-add refuses the late result with the
  // typed group hold rather than the generic version conflict.
  const bound = await bindAndAuthorizeAddressedTurnPublication(
    database,
    workspaceId,
    intentId,
    new Date().toISOString()
  )
  try {
    return await withAuthorizedLeadTurn(
      database,
      workspaceId,
      intentId,
      reader,
      false,
      (tx, intent) =>
        withAuthorizedLeadTurn(
          tx,
          workspaceId,
          intentId,
          { kind: 'user', userId: intent.actorUserId },
          true,
          async (publicationTx, admitted) => {
            const [row] = await publicationTx
              .select()
              .from(leadTurnRuntime)
              .where(eq(leadTurnRuntime.intentId, admitted.id))
              .for('update')
            if (!row || row.state !== 'completed') throw new Error('PUBLICATION_WITHHELD')
            assertBinding(row, binding)
            // A fenced admission never publishes, even for a completed result. The share lock serialises this check
            // against a concurrent fence on the same admission, and it runs before the grant is consulted.
            await assertLeadTurnNotFenced(publicationTx, admitted.id, 'share')
            // Trusted adapter rechecks current selection/payer/grant inside these held canonical locks.
            await assertCurrentGrant(publicationTx)
            // The FROZEN authorization is re-decided inside the publication
            // transaction, whose canonical locks (channel, roster and grants) are
            // already held: a roster mutation between the bind and the
            // publication lands as a typed hold instead of publishing under
            // superseded authority.
            if (bound)
              await assertAddressedTurnPublication(
                publicationTx,
                workspaceId,
                bound,
                new Date().toISOString()
              )
            const digest = createHash('sha256')
              .update(JSON.stringify({ ...binding, bodyText }))
              .digest('hex')
            if (row.publishedMessageId) {
              if (row.publicationDigest !== digest) throw new Error('RUNTIME_RESPONSE_INVALID')
              // A replayed publication repairs a binding an interrupted first attempt never wrote.
              await bindAddressedTurnResponse(
                publicationTx,
                workspaceId,
                admitted.id,
                row.publishedMessageId
              )
              return row.publishedMessageId
            }
            const message = await createRuntimeResultMessage(
              publicationTx,
              workspaceId,
              admitted.channelId,
              { kind: 'user', userId: admitted.actorUserId },
              {
                sender: { kind: 'agent', agentId: admitted.agentId },
                bodyText,
                executionRef: row.executionId,
                externalSessionRef: row.runtimeSessionId!,
                idempotencyKey: `lead-result:${admitted.id}`,
              }
            )
            await publicationTx
              .update(leadTurnRuntime)
              .set({ publishedMessageId: message.id, publicationDigest: digest })
              .where(eq(leadTurnRuntime.intentId, admitted.id))
            await bindAddressedTurnResponse(publicationTx, workspaceId, admitted.id, message.id)
            return message.id
          }
        )
    )
  } catch (error) {
    throw await explainGroupPublicationHold(error, database, workspaceId, bound)
  }
}
