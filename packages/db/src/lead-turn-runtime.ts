import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { UserPrincipalRef } from '@adea-ai/types'
import type { AgentHqDatabase } from './connection'
import { createRuntimeResultMessage } from './conversations'
import { assertLeadTurnNotFenced } from './lead-turn-rollback'
import { withAuthorizedLeadTurn, withHistoricalLeadTurn } from './lead-turns'
import { leadTurnRuntime } from './schema/lead-turn-runtime'

export type LeadTurnAcceptedSelection = Readonly<{
  workspaceId: string
  intentId: string
  executionId: string
  attemptId: string
  selectionRef: string
  selectionRevision: number
  preparationRef: string
  expiresAt: string
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
    intent: { id: string; messageId: string; actorUserId: string },
    controlPlaneWorkspaceId: string
  ) => ({
    intentId: intent.id,
    messageId: intent.messageId,
    workspaceId,
    controlPlaneWorkspaceId,
    originalActorRef: `user:${intent.actorUserId}` as const,
  })
  return purpose === 'effect'
    ? withAuthorizedLeadTurn(
        database,
        workspaceId,
        intentId,
        principal,
        true,
        async (_tx, intent, _message, cpWorkspaceId) => authority(intent, cpWorkspaceId)
      )
    : withHistoricalLeadTurn(
        database,
        workspaceId,
        intentId,
        principal,
        purpose === 'cancel',
        async (_tx, intent, _message, cpWorkspaceId) => authority(intent, cpWorkspaceId)
      )
}
export function readLeadTurnRuntime(
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
    false,
    async (tx, intent) => {
      const [row] = await tx
        .select()
        .from(leadTurnRuntime)
        .where(eq(leadTurnRuntime.intentId, intent.id))
      return row ? summary(row, intent.messageId) : undefined
    }
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
    false,
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
    false,
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
    true,
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
 * Terminal publication is distinct from execution. Raw progress can never call this boundary.
 * Publication appends a new Message, so it is an effect: it stays on the active-only effect gate,
 * and archived results remain unpublished (REQ 045).
 */
export function publishLeadTurnResult(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  reader: UserPrincipalRef,
  binding: LeadTurnRuntimeBinding,
  bodyText: string,
  assertCurrentGrant: () => Promise<void>
) {
  if (!bodyText.trim() || bodyText.length > 100_000 || typeof assertCurrentGrant !== 'function')
    throw new Error('PUBLICATION_WITHHELD')
  return withAuthorizedLeadTurn(database, workspaceId, intentId, reader, false, (tx, intent) =>
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
        // Trusted adapter rechecks current selection/payer/grant inside these held canonical locks.
        await assertCurrentGrant()
        const digest = createHash('sha256')
          .update(JSON.stringify({ ...binding, bodyText }))
          .digest('hex')
        if (row.publishedMessageId) {
          if (row.publicationDigest !== digest) throw new Error('RUNTIME_RESPONSE_INVALID')
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
        return message.id
      }
    )
  )
}
