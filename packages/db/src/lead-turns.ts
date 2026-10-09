import { randomUUID } from 'node:crypto'
import { authorizeWorkspaceAction } from '@adea-ai/auth/authorization'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  parseRequestedRoleModelSelections,
  sameRequestedRoleModelSelections,
  type RequestedRoleModelSelections,
} from './lead-model-selections'
import { createMessage } from './conversations'
import { evaluateGroupGrantWindow } from './group-participation-policy'
import { loadGroupAdmission, resolveGroupLeadAgentId } from './group-participation-store'
import {
  agents,
  channelParticipants,
  channels,
  messages,
  workspaceMemberships,
  workspaces,
} from './schema'
import { leadTurnIntents } from './schema/lead-turns'

type Database = AgentHqDatabase | AgentHqTransaction
type Intent = typeof leadTurnIntents.$inferSelect
type Input = Omit<
  Parameters<typeof createMessage>[4],
  | 'sender'
  | 'leadTurn'
  | 'executionRef'
  | 'externalSessionRef'
  | 'taskId'
  | 'threadRootMessageId'
  | 'replyToMessageId'
> & { requestedModelSelections?: RequestedRoleModelSelections }

/** Trusted wall time for lead boundaries; tests inject a deterministic clock. */
const liveLeadClock = () => new Date().toISOString()

/** Locks current admission authority through commit; no caller-supplied execution authority. */

function receipt(intent: Intent) {
  return Object.freeze({
    schemaVersion: 'pi-lead-intent/v1' as const,
    intentId: intent.id,
    messageId: intent.messageId,
    dispatchKey: intent.dispatchKey,
    state: 'blocked' as const,
    reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE' as const,
  })
}

/** Locks current admission authority through commit; no caller-supplied execution authority. */
async function lockAuthority(
  tx: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  requireAudienceMemberships = true,
  clock: () => string = liveLeadClock
) {
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .for('share')
  const [member] = await tx
    .select({ id: workspaceMemberships.id, role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .for('share')
  if (!workspace || !member) throw new Error('Lead turn unavailable')
  if (
    requireAudienceMemberships &&
    !(
      await authorizeWorkspaceAction(
        { permission: 'runtime.invoke', principal, workspaceId },
        { findMembership: async () => member }
      )
    ).allowed
  )
    throw new Error('Lead turn unavailable')
  const [channel] = await tx
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.id, channelId),
        eq(channels.workspaceId, workspaceId),
        eq(channels.lifecycleState, 'active')
      )
    )
    .for('update')
  if (!channel || channel.taskId) throw new Error('Lead turn unavailable')
  // Trusted time is read AFTER the channel lock above, so a grant expiring
  // while this transaction waited still denies here.
  const now = clock()
  // Group admission (targetless): the caller's canonical admission must be
  // effective for EVERY entry point — createLeadTurn, inspection and replay
  // alike — never just the HTTP wrapper. A direct channel keeps its bound
  // agent; neither path weakens the other, and no handoff target is read or
  // required here. Admission and grant rows lock with the decision in this
  // same transaction, so a concurrent revocation orders before or after the
  // authority — never inside it.
  if (channel.kind === 'group') {
    const admission = await loadGroupAdmission(
      tx,
      workspaceId,
      channelId,
      { kind: 'user', userId: principal.userId },
      { forUpdate: true }
    )
    if (!admission || evaluateGroupGrantWindow(admission.grant, now) !== 'effective')
      throw new Error('Lead turn unavailable')
  }
  const groupLeadAgentId =
    channel.kind === 'group' && !channel.agentId
      ? await resolveGroupLeadAgentId(tx, workspaceId, channelId, now, { forUpdate: true })
      : null
  const leadAgentId = channel.kind === 'direct_agent' ? channel.agentId : groupLeadAgentId
  if (!leadAgentId) throw new Error('Lead turn unavailable')
  const [agent] = await tx
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, leadAgentId),
        eq(agents.workspaceId, workspaceId),
        eq(agents.isWorkspaceLead, true),
        eq(agents.lifecycleState, 'active'),
        isNull(agents.projectId)
      )
    )
    .for('share')
  const participants = await tx
    .select()
    .from(channelParticipants)
    .where(
      and(
        eq(channelParticipants.workspaceId, workspaceId),
        eq(channelParticipants.channelId, channelId)
      )
    )
    .for('share')
  if (
    !agent ||
    !participants.some((p) => p.principalKind === 'user' && p.userId === principal.userId) ||
    !participants.some((p) => p.principalKind === 'agent' && p.agentId === agent.id)
  )
    throw new Error('Lead turn unavailable')
  if (requireAudienceMemberships) {
    const audienceUsers = participants.flatMap((p) => (p.userId ? [p.userId] : []))
    const audienceMemberships = await tx
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          inArray(workspaceMemberships.userId, audienceUsers)
        )
      )
      .for('share')
    if (audienceMemberships.length !== audienceUsers.length)
      throw new Error('Lead turn unavailable')
  }
  const audience = participants
    .map((p) => (p.principalKind === 'user' ? `user:${p.userId}` : `agent:${p.agentId}`))
    .toSorted()
  return {
    actorUserId: principal.userId,
    agentId: agent.id,
    controlPlaneAgentId: agent.controlPlaneAgentId,
    profileId: agent.profileId,
    profileVersion: agent.profileVersion,
    profileRevision: agent.profileRevision,
    channelVersion: channel.version,
    channelVisibility: channel.visibility,
    audience,
  }
}

function assertPinned(
  intent: Intent,
  authority: Awaited<ReturnType<typeof lockAuthority>>,
  requireOriginalActor = true
) {
  if (requireOriginalActor && intent.actorUserId !== authority.actorUserId)
    throw new Error('Lead turn version conflict')
  for (const key of [
    'agentId',
    'controlPlaneAgentId',
    'profileId',
    'profileVersion',
    'profileRevision',
    'channelVersion',
    'channelVisibility',
  ] as const)
    if (intent[key] !== authority[key]) throw new Error('Lead turn version conflict')
  if (JSON.stringify(intent.audience) !== JSON.stringify(authority.audience))
    throw new Error('Lead turn version conflict')
}

/**
 * Post-write group freshness for a just-written lead turn. Direct channels
 * return immediately (their authority carries no group binding); group
 * channels re-resolve the actor admission and the selected lead on fresh
 * trusted time and require the SAME lead the authority admitted. Anything
 * else throws and the caller's transaction rolls everything back.
 */
async function assertGroupLeadFreshness(
  tx: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  authority: Readonly<{ agentId: string }>,
  clock: () => string
): Promise<void> {
  const [channel] = await tx
    .select({ kind: channels.kind })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
    .limit(1)
  if (!channel || channel.kind !== 'group') return
  const now = clock()
  const admission = await loadGroupAdmission(
    tx,
    workspaceId,
    channelId,
    { kind: 'user', userId: principal.userId },
    { forUpdate: true }
  )
  if (!admission || evaluateGroupGrantWindow(admission.grant, now) !== 'effective')
    throw new Error('Lead turn unavailable')
  const leadAgentId = await resolveGroupLeadAgentId(tx, workspaceId, channelId, now, {
    forUpdate: true,
  })
  if (leadAgentId !== authority.agentId) throw new Error('Lead turn unavailable')
}

/** Message, message event, and blocked dispatch intent commit as one durable unit. */
export async function createLeadTurn(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: Input,
  // Test-only trusted clock; production callers omit it and read live wall
  // time inside the transaction. Never an HTTP caller-supplied instant.
  options: Readonly<{ clock?: () => string }> = {}
) {
  const allowed = new Set([
    'artifactIds',
    'bodyContentRefId',
    'bodyText',
    'idempotencyKey',
    'mentions',
    'requestedModelSelections',
  ])
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    !input.idempotencyKey?.trim() ||
    input.idempotencyKey.length > 128
  )
    throw new Error('Invalid lead turn')
  const requestedModelSelections = parseRequestedRoleModelSelections(input.requestedModelSelections)
  const { requestedModelSelections: _requested, ...messageInput } = input
  const clock = options.clock ?? liveLeadClock
  return database.transaction(async (tx) => {
    const authority = await lockAuthority(tx, workspaceId, channelId, principal, true, clock)
    const message = await createMessage(tx, workspaceId, channelId, principal, {
      ...messageInput,
      sender: principal,
      leadTurn: true,
    })
    if (message.deletedAt) throw new Error('Lead turn unavailable')
    // Post-write group freshness: the awaited write above may have waited on
    // locks until after a grant lapsed. Both the actor admission and the
    // selected lead enlistment are re-resolved on fresh trusted time and
    // must still name the authority that admitted them; denial throws and
    // rolls back the message, the intent and the event with zero rows.
    await assertGroupLeadFreshness(tx, workspaceId, channelId, principal, authority, clock)
    const [existing] = await tx
      .select()
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.messageId, message.id))
    if (existing) {
      assertPinned(existing, authority)
      if (
        !sameRequestedRoleModelSelections(
          existing.requestedModelSelections ?? undefined,
          requestedModelSelections
        )
      )
        throw new Error('Lead turn model selection conflict')
      // Final freshness covers the replay path too: the awaited intent
      // select above may have waited on locks until after a grant lapsed.
      await assertGroupLeadFreshness(tx, workspaceId, channelId, principal, authority, clock)
      return { message, leadTurn: receipt(existing) }
    }
    const id = randomUUID()
    const [intent] = await tx
      .insert(leadTurnIntents)
      .values({
        ...authority,
        id,
        dispatchKey: `lead-turn:${id}`,
        requestedModelSelections: requestedModelSelections ?? null,
        messageId: message.id,
        workspaceId,
        channelId,
      })
      .returning()
    if (!intent) throw new Error('Lead turn unavailable')
    // Final trusted-time check after ALL intended writes (message, event,
    // intent insert): first-time lock waits are inside the boundary, so a
    // grant lapsing anywhere up to the commit still denies and rolls back
    // every effect with zero rows surviving.
    await assertGroupLeadFreshness(tx, workspaceId, channelId, principal, authority, clock)
    return { message, leadTurn: receipt(intent) }
  })
}

/** Inspection is authorized against live authority, never a persisted grant. */
export async function getLeadTurnForUser(
  database: Database,
  workspaceId: string,
  messageId: string,
  principal: UserPrincipalRef
) {
  return database.transaction(async (tx) => {
    const [message] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.workspaceId, workspaceId),
          isNull(messages.deletedAt)
        )
      )
    if (!message) throw new Error('Lead turn unavailable')
    const authority = await lockAuthority(tx, workspaceId, message.channelId, principal, false)
    const [liveMessage] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
      .for('share')
    if (!liveMessage) throw new Error('Lead turn unavailable')
    const [intent] = await tx
      .select()
      .from(leadTurnIntents)
      .where(
        and(eq(leadTurnIntents.messageId, messageId), eq(leadTurnIntents.workspaceId, workspaceId))
      )
    if (!intent) return null
    assertPinned(intent, authority, false)
    return receipt(intent)
  })
}

/** Trusted server repository boundary. Pins and current audience are held through operation commit. */
export async function withAuthorizedLeadTurn<T>(
  database: Database,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef,
  mutation: boolean,
  operation: (
    tx: AgentHqTransaction,
    intent: Intent,
    message: typeof messages.$inferSelect,
    controlPlaneWorkspaceId: string
  ) => Promise<T>
) {
  return database.transaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(leadTurnIntents)
      .where(and(eq(leadTurnIntents.id, intentId), eq(leadTurnIntents.workspaceId, workspaceId)))
    if (!intent || (mutation && intent.actorUserId !== principal.userId))
      throw new Error('Lead turn unavailable')
    const authority = await lockAuthority(tx, workspaceId, intent.channelId, principal, mutation)
    assertPinned(intent, authority, mutation)
    const [message] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, intent.messageId),
          eq(messages.workspaceId, workspaceId),
          isNull(messages.deletedAt)
        )
      )
      .for('share')
    const [workspace] = await tx
      .select({ id: workspaces.controlPlaneWorkspaceId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
    if (!message || message.senderUserId !== intent.actorUserId || !workspace)
      throw new Error('Lead turn unavailable')
    return operation(tx, intent, message, workspace.id)
  })
}

/** Reload recovery uses canonical topic identity and current participant authority, never browser session state. */
export async function getLatestLeadTurnForChannel(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef
) {
  return database.transaction(async (tx) => {
    await lockAuthority(tx, workspaceId, channelId, principal, false)
    const [latest] = await tx
      .select({ id: leadTurnIntents.id })
      .from(leadTurnIntents)
      .innerJoin(messages, eq(messages.id, leadTurnIntents.messageId))
      .where(
        and(
          eq(leadTurnIntents.workspaceId, workspaceId),
          eq(leadTurnIntents.channelId, channelId),
          isNull(messages.deletedAt)
        )
      )
      .orderBy(sql`${messages.sequence} desc`)
      .limit(1)
    if (!latest) return null
    return withAuthorizedLeadTurn(
      tx,
      workspaceId,
      latest.id,
      principal,
      false,
      async (_tx, intent) => receipt(intent)
    )
  })
}
