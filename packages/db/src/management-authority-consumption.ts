import { and, eq } from 'drizzle-orm'
import type {
  ManagementAuthorityClaim,
  ManagementAuthorityCompletion,
} from '@adea-ai/types/management'

import type { AgentHqDatabase } from './connection'
import { managementAuthorityConsumptions } from './schema'

/**
 * Durable idempotency claim for one CP-issued lead management decision
 * (M14.03.1, adea-ai/adea#1215).
 *
 * `claimManagementAuthorityDecision` inserts the exact-call claim before the
 * effect; a replay finds the retained row and is answered without a second
 * effect. `completeManagementAuthorityDecision` marks the retained outcome.
 * The database row, not a process-local set, is the primary owner: the unique
 * `decision_id` and the `claimed` state survive workers, cold restarts and any
 * in-memory eviction. An interrupted claim is never retried automatically —
 * the caller receives `recovery_required` so a duplicate effect is impossible
 * and a fresh authorized decision owns the retry.
 *
 * Only digests and identifiers are stored; raw input, prompts and credentials
 * are never written here.
 */
export type {
  ManagementAuthorityClaim,
  ManagementAuthorityCompletion,
} from '@adea-ai/types/management'

export type ManagementAuthorityClaimInput = Readonly<{
  decisionId: string
  workspaceId: string
  authorityRef: string
  authorityRevision: number
  operation: string
  targetId: string | null
  actionDigest: string
  inputDigest: string
  targetDigest: string
}>

/**
 * Atomically claims the decision for the exact call. The insert-or-read runs in
 * one transaction so two concurrent deliveries cannot both believe they own the
 * effect: one inserts, the other blocks on the unique key and then sees the
 * retained row.
 */
export async function claimManagementAuthorityDecision(
  database: AgentHqDatabase,
  input: ManagementAuthorityClaimInput
): Promise<ManagementAuthorityClaim> {
  return database.transaction(async (transaction) => {
    const [inserted] = await transaction
      .insert(managementAuthorityConsumptions)
      .values({ ...input, state: 'claimed' })
      .onConflictDoNothing({ target: managementAuthorityConsumptions.decisionId })
      .returning({ id: managementAuthorityConsumptions.id })
    if (inserted) return Object.freeze({ state: 'claimed' as const })

    const [existing] = await transaction
      .select()
      .from(managementAuthorityConsumptions)
      .where(eq(managementAuthorityConsumptions.decisionId, input.decisionId))
      .for('update')
    if (!existing)
      return Object.freeze({ priorState: 'claimed' as const, state: 'recovery_required' as const })

    // One decision id may only ever name one exact call. A different binding
    // under the same id is a conflict, never a second effect.
    const sameCall =
      existing.workspaceId === input.workspaceId &&
      existing.authorityRef === input.authorityRef &&
      existing.authorityRevision === input.authorityRevision &&
      existing.operation === input.operation &&
      existing.targetId === input.targetId &&
      existing.actionDigest === input.actionDigest &&
      existing.inputDigest === input.inputDigest &&
      existing.targetDigest === input.targetDigest
    if (!sameCall)
      return Object.freeze({
        priorState: existing.state,
        state: 'recovery_required' as const,
      })
    if (existing.state === 'succeeded')
      return Object.freeze({ resultDigest: existing.resultDigest, state: 'replayed' as const })
    return Object.freeze({ priorState: existing.state, state: 'recovery_required' as const })
  })
}

/** Marks the retained claim after the effect; only a `claimed` row transitions. */
export async function completeManagementAuthorityDecision(
  database: AgentHqDatabase,
  decisionId: string,
  completion: ManagementAuthorityCompletion
): Promise<boolean> {
  const [updated] = await database
    .update(managementAuthorityConsumptions)
    .set({
      completedAt: new Date(),
      ...(completion.state === 'succeeded' ? { resultDigest: completion.resultDigest } : {}),
      ...(completion.state === 'failed' ? { failureCode: completion.failureCode } : {}),
      state: completion.state,
    })
    .where(
      and(
        eq(managementAuthorityConsumptions.decisionId, decisionId),
        eq(managementAuthorityConsumptions.state, 'claimed')
      )
    )
    .returning({ id: managementAuthorityConsumptions.id })
  return Boolean(updated)
}
