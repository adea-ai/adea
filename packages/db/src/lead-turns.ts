import { randomUUID } from 'node:crypto'
import { authorizeWorkspaceAction } from '@adea-ai/auth/authorization'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  parseRequestedRoleModelSelections,
  sameRequestedRoleModelSelections,
  type RequestedRoleModelSelections,
} from './lead-model-selections'
import { createMessage, messageSummary, requireVisibleTask } from './conversations'
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
> & { handoffTarget?: HandoffTarget } & {
  requestedModelSelections?: RequestedRoleModelSelections
}
> & { handoffTarget?: HandoffTarget }

/** Structured handoff target: the exact direct session this admission coordinates. */
export type HandoffTarget = Readonly<{
  runtimeSessionId: string
  taskId: string
  expectedGeneration: number
}>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validates the caller-supplied handoff target; the task itself is resolved server-side. */
export function parseHandoffTarget(value: unknown): HandoffTarget | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid lead turn')
  const record = value as Record<string, unknown>
  if (
    !Object.keys(record).every(
      (key) => key === 'runtimeSessionId' || key === 'taskId' || key === 'expectedGeneration'
    )
  )
    throw new Error('Invalid lead turn')
  const { runtimeSessionId, taskId, expectedGeneration } = record
  if (
    typeof runtimeSessionId !== 'string' ||
    !runtimeSessionId.trim() ||
    runtimeSessionId.trim().length > 256
  )
    throw new Error('Invalid lead turn')
  if (typeof taskId !== 'string' || !UUID_PATTERN.test(taskId)) throw new Error('Invalid lead turn')
  if (
    typeof expectedGeneration !== 'number' ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0
  )
    throw new Error('Invalid lead turn')
  return { runtimeSessionId: runtimeSessionId.trim(), taskId, expectedGeneration }
}

function receipt(intent: Intent) {
  return Object.freeze({
    schemaVersion: 'pi-lead-intent/v1' as const,
    intentId: intent.id,
    messageId: intent.messageId,
    dispatchKey: intent.dispatchKey,
    state: 'blocked' as const,
    reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE' as const,
    ...(intent.handoffTargetSessionId !== null && intent.handoffTargetGeneration !== null
      ? {
          handoffTarget: {
            runtimeSessionId: intent.handoffTargetSessionId,
            ...(intent.handoffTargetTaskId !== null ? { taskId: intent.handoffTargetTaskId } : {}),
            observedGeneration: intent.handoffTargetGeneration,
          },
        }
      : {}),
  })
}

/** Locks current admission authority through commit; no caller-supplied execution authority. */
async function lockAuthority(
  tx: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  requireAudienceMemberships = true
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
  if (!channel || channel.kind !== 'direct_agent' || !channel.agentId || channel.taskId)
    throw new Error('Lead turn unavailable')
  const [agent] = await tx
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, channel.agentId),
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

/** Message, message event, and blocked dispatch intent commit as one durable unit. */
export async function createLeadTurn(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: Input
) {
  const allowed = new Set([
    'artifactIds',
    'bodyContentRefId',
    'bodyText',
    'handoffTarget',
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
  const handoffTarget = parseHandoffTarget(input.handoffTarget)
  const {
    requestedModelSelections: _requested,
    handoffTarget: _handoffTarget,
    ...messageInput
  } = input
  return database.transaction(async (tx) => {
    const authority = await lockAuthority(tx, workspaceId, channelId, principal)
    // The claimed task is server-resolved authority: it must be a visible
    // task, and it is stamped on the intent so later reads can tell a
    // retargeted or phantom task from the admitted one.
    if (handoffTarget) await requireVisibleTask(tx, workspaceId, handoffTarget.taskId, principal)
    // Canonical recovery before another admission: a retained intent for the
    // exact target context dedupes reload/eviction retries without any
    // client-held request identity. Same generation recovers, a retained
    // newer generation rejects the stale request, an older one is superseded.
    if (handoffTarget) {
      const retained = await findRetainedTargetIntent(
        tx,
        workspaceId,
        channelId,
        handoffTarget.runtimeSessionId
      )
      if (retained) {
        assertPinned(retained, authority)
        if (retained.handoffTargetGeneration === handoffTarget.expectedGeneration)
          return {
            message: await requireIntentMessage(tx, workspaceId, retained),
            leadTurn: receipt(retained),
          }
        if (
          retained.handoffTargetGeneration !== null &&
          retained.handoffTargetGeneration > handoffTarget.expectedGeneration
        )
          throw new Error('Lead turn target superseded')
      }
    }
    const message = await createMessage(tx, workspaceId, channelId, principal, {
      ...messageInput,
      sender: principal,
      leadTurn: true,
    })
    if (message.deletedAt) throw new Error('Lead turn unavailable')
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
      return { message, leadTurn: receipt(existing) }
    }
    const id = randomUUID()
    let inserted: Intent | undefined
    try {
      const [intent] = await tx
        .insert(leadTurnIntents)
        .values({
          ...authority,
          id,
          dispatchKey: `lead-turn:${id}`,
          requestedModelSelections: requestedModelSelections ?? null,
          ...(handoffTarget
            ? {
                handoffTargetSessionId: handoffTarget.runtimeSessionId,
                handoffTargetGeneration: handoffTarget.expectedGeneration,
                handoffTargetTaskId: handoffTarget.taskId,
              }
            : {}),
          messageId: message.id,
          workspaceId,
          channelId,
        })
        .returning()
      inserted = intent
    } catch (error) {
      // Race backstop for the recovery above: a concurrent same-target
      // admission won the unique target context. Recover the winner instead
      // of surfacing a duplicate or a constraint error.
      if (
        handoffTarget &&
        error instanceof Error &&
        error.message.includes('lead_turn_intents_target_unique')
      ) {
        const winner = await findRetainedTargetIntent(
          tx,
          workspaceId,
          channelId,
          handoffTarget.runtimeSessionId
        )
        if (winner && winner.handoffTargetGeneration === handoffTarget.expectedGeneration) {
          assertPinned(winner, authority)
          return {
            message: await requireIntentMessage(tx, workspaceId, winner),
            leadTurn: receipt(winner),
          }
        }
      }
      throw error
    }
    if (!inserted) throw new Error('Lead turn unavailable')
    return { message, leadTurn: receipt(inserted) }
  })
}

/** Latest retained intent for one exact target session, newest generation first. */
async function findRetainedTargetIntent(
  tx: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  targetSessionId: string
): Promise<Intent | undefined> {
  const [retained] = await tx
    .select({ intent: leadTurnIntents })
    .from(leadTurnIntents)
    .innerJoin(messages, eq(messages.id, leadTurnIntents.messageId))
    .where(
      and(
        eq(leadTurnIntents.workspaceId, workspaceId),
        eq(leadTurnIntents.channelId, channelId),
        eq(leadTurnIntents.handoffTargetSessionId, targetSessionId),
        isNull(messages.deletedAt)
      )
    )
    .orderBy(desc(leadTurnIntents.handoffTargetGeneration), sql`${messages.sequence} desc`)
    .limit(1)
  return retained?.intent
}

async function requireIntentMessage(tx: AgentHqTransaction, workspaceId: string, intent: Intent) {
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
  if (!message) throw new Error('Lead turn unavailable')
  return messageSummary(tx, message)
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

/** Exact-target read: the latest retained intent for one session, never a task-wide latest.
 *  Reload recovery uses the retained target identity, never browser session state. */
export async function getLatestLeadTurnForTarget(
  database: Database,
  workspaceId: string,
  channelId: string,
  targetSessionId: string,
  principal: UserPrincipalRef
) {
  return database.transaction(async (tx) => {
    await lockAuthority(tx, workspaceId, channelId, principal, false)
    const retained = await findRetainedTargetIntent(tx, workspaceId, channelId, targetSessionId)
    if (!retained) return null
    return withAuthorizedLeadTurn(
      tx,
      workspaceId,
      retained.id,
      principal,
      false,
      async (_tx, intent) => receipt(intent)
    )
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
