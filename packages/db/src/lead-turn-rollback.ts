import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { withHistoricalLeadTurn } from './lead-turns'
import { channels } from './schema/conversations'
import {
  assertLeadTurnRollbackFenceRequest,
  attributionOf,
  classifyLeadTurnRollback,
  type LeadTurnRollbackAttribution,
  type LeadTurnRollbackDisposition,
  type LeadTurnRollbackFenceActor,
  type LeadTurnRollbackFenceAuthority,
  type LeadTurnRollbackFenceRequest,
} from './lead-turn-rollback-policy'
import { leadTurnIntents } from './schema/lead-turns'
import { leadTurnRuntime } from './schema/lead-turn-runtime'
import { workspaceMemberships } from './schema/workspaces'

// The pure classification, validation and attribution live in the policy module so unit tests can
// load them without the database layer. They stay part of this module's public surface.
export * from './lead-turn-rollback-policy'

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

async function resolveFenceActor(
  tx: AgentHqTransaction,
  workspaceId: string,
  actor: LeadTurnRollbackFenceActor
): Promise<Readonly<{ membershipId: string | null; role: 'owner' | 'admin' | null }>> {
  if (actor.kind === 'operator') return { membershipId: null, role: null }
  const [member] = await tx
    .select({ id: workspaceMemberships.id, role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, actor.principal.userId)
      )
    )
    .for('share')
  if (!member) throw new Error('Lead turn unavailable')
  if (member.role !== 'owner' && member.role !== 'admin')
    throw new Error('ROLLBACK_FENCE_FORBIDDEN')
  return { membershipId: member.id, role: member.role }
}

export type LeadTurnRollbackFence = Readonly<{
  intentId: string
  disposition: LeadTurnRollbackDisposition
  fenced: boolean
  /** True when an earlier fence already held. The original attribution is returned, not replaced. */
  alreadyFenced: boolean
  attribution?: LeadTurnRollbackAttribution
}>

/**
 * Trusted rollback boundary, called by server rollback tooling and never by a user principal.
 * A user actor must currently be a workspace owner or admin, checked under lock in the same
 * transaction as the write. The first fence keeps its attribution; later calls return it unchanged.
 * A terminal admission is fenced the same way, with disposition `terminal_retained`. Only the
 * intent's fence columns are written. The runtime row is read under lock and left unchanged.
 */
export async function fenceLeadTurnForRollback(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  request: LeadTurnRollbackFenceRequest
): Promise<LeadTurnRollbackFence> {
  assertLeadTurnRollbackFenceRequest(request)
  return database.transaction(async (tx) => {
    // Discover the immutable channel reference without taking an intent lock. Every effect
    // acquires channel authority before its intent lock; taking them in reverse can deadlock.
    const [reference] = await tx
      .select({ channelId: leadTurnIntents.channelId })
      .from(leadTurnIntents)
      .where(and(eq(leadTurnIntents.id, intentId), eq(leadTurnIntents.workspaceId, workspaceId)))
    if (!reference) throw new Error('Lead turn unavailable')
    const actor = await resolveFenceActor(tx, workspaceId, request.actor)
    const [channel] = await tx
      .select({
        id: channels.id,
        version: channels.version,
        lifecycleState: channels.lifecycleState,
      })
      .from(channels)
      .where(and(eq(channels.id, reference.channelId), eq(channels.workspaceId, workspaceId)))
      .for('share')
    if (!channel) throw new Error('Lead turn unavailable')
    // Read the current fence only after both locks are held, including concurrent first fences.
    const [intent] = await tx
      .select()
      .from(leadTurnIntents)
      .where(
        and(
          eq(leadTurnIntents.id, intentId),
          eq(leadTurnIntents.workspaceId, workspaceId),
          eq(leadTurnIntents.channelId, channel.id)
        )
      )
      .for('update')
    if (!intent) throw new Error('Lead turn unavailable')
    const [row] = await tx
      .select()
      .from(leadTurnRuntime)
      .where(eq(leadTurnRuntime.intentId, intentId))
      .for('update')
    if (intent.rollbackFencedAt) {
      return {
        intentId,
        disposition: classifyLeadTurnRollback({ fenced: true, runtime: row }),
        fenced: true,
        alreadyFenced: true,
        attribution: attributionOf(intent),
      }
    }
    // A terminal runtime classifies as `terminal_retained`. Its row is only read here, so its
    // history is unchanged, but the admission still gets attribution and a publication block.
    const disposition = classifyLeadTurnRollback({ fenced: true, runtime: row })
    const authority: LeadTurnRollbackFenceAuthority = {
      schemaVersion: 1,
      workspaceId,
      actorMembershipId: actor.membershipId,
      actorRole: actor.role,
      channelId: channel.id,
      channelVersion: channel.version,
      channelLifecycleState: channel.lifecycleState,
      runtimeState: row?.state ?? null,
      disposition,
    }
    const [updated] = await tx
      .update(leadTurnIntents)
      .set({
        rollbackFencedAt: new Date(),
        rollbackFenceActorKind: request.actor.kind,
        rollbackFenceActorRef:
          request.actor.kind === 'user' ? request.actor.principal.userId : request.actor.operatorId,
        rollbackFenceReason: request.reason,
        rollbackFenceAuthority: authority,
      })
      .where(and(eq(leadTurnIntents.id, intentId), isNull(leadTurnIntents.rollbackFencedAt)))
      .returning()
    if (!updated) throw new Error('Lead turn unavailable')
    return {
      intentId,
      disposition,
      fenced: true,
      alreadyFenced: false,
      attribution: attributionOf(updated),
    }
  })
}

export type LeadTurnRollbackState = Readonly<{
  intentId: string
  messageId: string
  channelLifecycleState: 'active' | 'archived'
  disposition: LeadTurnRollbackDisposition
  fenced: boolean
  attribution?: LeadTurnRollbackAttribution
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
 * Rollback reader for a current participant. It uses the canonical historical boundary shared with
 * getLeadTurnForUser and readLeadTurnRuntime, so authorized archived history stays observable and
 * no effect is granted. A denied user gets the same unavailable answer and learns nothing about
 * the fence.
 */
export function readLeadTurnRollbackState(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef
): Promise<LeadTurnRollbackState> {
  return withHistoricalLeadTurn(
    database,
    workspaceId,
    intentId,
    principal,
    'read',
    async (tx, intent, _message, _controlPlaneWorkspaceId, channel) => {
      const [row] = await tx
        .select()
        .from(leadTurnRuntime)
        .where(eq(leadTurnRuntime.intentId, intent.id))
      const fenced = intent.rollbackFencedAt !== null
      const attribution = attributionOf(intent)
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
        channelLifecycleState: channel.lifecycleState,
        disposition: classifyLeadTurnRollback({ fenced, runtime: row }),
        fenced,
        ...(attribution ? { attribution } : {}),
        ...(runtime ? { runtime } : {}),
      }
    }
  )
}
