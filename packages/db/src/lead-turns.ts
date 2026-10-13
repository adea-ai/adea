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
import {
  createMessage,
  createMessageInGroupFence,
  messageSummary,
  requireVisibleTask,
} from './conversations'
import { evaluateGroupGrantWindow } from './group-participation-policy'
import { loadGroupAdmission, resolveGroupLeadAgentId } from './group-participation-store'
import { filterVisibleMessageRows } from './job-outbound-read'
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
  return {
    runtimeSessionId: runtimeSessionId.trim(),
    taskId: taskId.toLowerCase(),
    expectedGeneration,
  }
}

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
  // Tool authority is source-scoped: a group lead Agent is pinned in its
  // own home workspace (proved at enlist time), never the host's. Direct
  // channels keep their bound agent; the row read is identical either way.
  const [agent] = await tx
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, leadAgentId),
        ...(channel.kind === 'group' ? [] : [eq(agents.workspaceId, workspaceId)]),
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

/** Message, message event, and blocked dispatch intent commit as one durable unit.
 *
 *  A structured handoff target is accepted only over the authenticated
 *  desktop-host channel (`options.hostMediated`, asserted by the route from
 *  a validated Desktop credential): the cloud holds no session facts, so a
 *  bare session id can never prove binding, currency, or control
 *  permission here. Unmediated target claims fail closed before anything
 *  is retained, which keeps every retained target host-channeled by
 *  construction — reads never see a forged binding. A target is a direct
 *  lead conversation's property; a group never carries one. */
export async function createLeadTurn(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: Input,
  // Test-only trusted clock; production callers omit it and read live wall
  // time inside the transaction. Never an HTTP caller-supplied instant.
  options: Readonly<{ clock?: () => string; hostMediated?: boolean }> = {}
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
  if (input.handoffTarget !== undefined && options.hostMediated !== true)
    throw new Error('Lead turn target requires host mediation')
  const requestedModelSelections = parseRequestedRoleModelSelections(input.requestedModelSelections)
  const handoffTarget = parseHandoffTarget(input.handoffTarget)
  const {
    requestedModelSelections: _requested,
    handoffTarget: _handoffTarget,
    ...messageInput
  } = input
  const clock = options.clock ?? liveLeadClock
  return database.transaction(async (tx) => {
    const authority = await lockAuthority(tx, workspaceId, channelId, principal, true, clock)
    if (handoffTarget) {
      // The channel is locked by the authority above, so its kind cannot change under us.
      const [channel] = await tx
        .select({ kind: channels.kind })
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
      if (channel?.kind !== 'direct_agent') throw new Error('Lead turn unavailable')
      // The claimed task is server-resolved authority: it must be a visible
      // task, and it is stamped on the intent so later reads can tell a
      // retargeted or phantom task from the admitted one.
      await requireVisibleTask(tx, workspaceId, handoffTarget.taskId, principal)
    }
    // A message key already belongs to its immutable target, even when the
    // newly requested target has another recoverable intent of its own.
    // Check before target recovery can return that unrelated receipt.
    const [keyed] = await tx
      .select({ messageId: messages.id, intent: leadTurnIntents })
      .from(messages)
      .leftJoin(leadTurnIntents, eq(leadTurnIntents.messageId, messages.id))
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          eq(messages.channelId, channelId),
          eq(messages.idempotencyKey, input.idempotencyKey.trim())
        )
      )
      .limit(1)
    // A plain message owns its key too; target recovery cannot adopt it.
    if (keyed && !keyed.intent) throw new Error('Message idempotency conflict')
    if (
      keyed?.intent &&
      (keyed.intent.handoffTargetSessionId !== (handoffTarget?.runtimeSessionId ?? null) ||
        keyed.intent.handoffTargetTaskId !== (handoffTarget?.taskId ?? null) ||
        keyed.intent.handoffTargetGeneration !== (handoffTarget?.expectedGeneration ?? null))
    )
      throw new Error('Lead turn target mismatch')
    // Canonical recovery before another admission: a retained intent for the
    // exact target context dedupes reload/eviction retries without any
    // client-held request identity. The COMPLETE retained target must match:
    // same session and generation but a different task is a contradictory
    // claim about one context and fails closed. A different generation
    // mints anew (ordering, never ground truth: the session host alone
    // knows current generation, and display currency is decided where the
    // live generation is known). Serialization note: createLeadTurn is the
    // sole inserter and holds the channel FOR UPDATE lock (lockAuthority)
    // before any insert, so concurrent same-target admissions serialize and
    // the loser always finds the winner here; the partial unique target
    // index below is the backstop, not a path with its own recovery.
    if (handoffTarget) {
      const retained = await findTargetIntent(
        tx,
        workspaceId,
        channelId,
        handoffTarget.runtimeSessionId,
        handoffTarget.expectedGeneration
      )
      if (retained) {
        assertPinned(retained, authority)
        if (retained.handoffTargetTaskId !== handoffTarget.taskId)
          throw new Error('Lead turn target mismatch')
        // Explicit choices are identity too: a changed selection must hit
        // the same conflict the message-idempotency path reports, never a
        // silent return of the old receipt.
        if (
          !sameRequestedRoleModelSelections(
            retained.requestedModelSelections ?? undefined,
            requestedModelSelections
          )
        )
          throw new Error('Lead turn model selection conflict')
        return {
          message: await requireIntentMessage(tx, workspaceId, retained),
          leadTurn: receipt(retained),
        }
      }
    }
    const message = await createMessageInGroupFence(tx, workspaceId, channelId, principal, {
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
    if (!intent) throw new Error('Lead turn unavailable')
    // Final trusted-time check after ALL intended writes (message, event,
    // intent insert): first-time lock waits are inside the boundary, so a
    // grant lapsing anywhere up to the commit still denies and rolls back
    // every effect with zero rows surviving.
    await assertGroupLeadFreshness(tx, workspaceId, channelId, principal, authority, clock)
    return { message, leadTurn: receipt(intent) }
  })
}

/** Retained intent for one complete target context, if any. At most one row
 *  can match: the partial unique target index enforces a single intent per
 *  (workspace, channel, session, generation). */
async function findTargetIntent(
  tx: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  targetSessionId: string,
  targetGeneration: number
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
        eq(leadTurnIntents.handoffTargetGeneration, targetGeneration),
        isNull(messages.deletedAt)
      )
    )
    .limit(1)
  return retained?.intent
}

/** Latest retained intent for one exact target session, newest generation first. */
async function findLatestTargetIntent(
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
  // A retained turn on a message the reader cannot see is unavailable, as the message is.
  if ((await filterVisibleMessageRows(tx, [message], intent.actorUserId)).length === 0)
    throw new Error('Lead turn unavailable')
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
    // A turn on a message the reader cannot see is unavailable, as the message is.
    if ((await filterVisibleMessageRows(tx, [message], principal.userId)).length === 0)
      throw new Error('Lead turn unavailable')
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
    if ((await filterVisibleMessageRows(tx, [message], principal.userId)).length === 0)
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
    const retained = await findLatestTargetIntent(tx, workspaceId, channelId, targetSessionId)
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
