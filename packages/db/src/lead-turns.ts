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
import { parseHandoffTarget, type HandoffTarget } from './lead-turn-handoff-target'
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
import { leadTurnRuntime } from './schema/lead-turn-runtime'
import { leadTurnIntents } from './schema/lead-turns'
import { addressedAgentTurns } from './schema/addressed-agent-turns'

export { parseHandoffTarget, type HandoffTarget }

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
  clock: () => string = liveLeadClock,
  // When provided, the resolved lead must equal the expected addressed
  // Agent INSIDE this same transaction: a lead change racing admission
  // denies instead of launching a different Agent.
  expectedAgentId?: string
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
  if (expectedAgentId !== undefined && leadAgentId !== expectedAgentId)
    throw new Error('Lead turn unavailable')
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

type LockedAuthority = Awaited<ReturnType<typeof lockAuthority>>

function assertPinned(intent: Intent, authority: LockedAuthority, requireOriginalActor = true) {
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
    let targetAttempt = 1
    if (handoffTarget) {
      // A replay of a retained key returns that exact admission, current or historical: a key
      // never reaches a successor created under another key.
      if (keyed?.intent) {
        assertPinned(keyed.intent, authority)
        assertSameModelSelections(keyed.intent, requestedModelSelections)
        return {
          message: await requireIntentMessage(tx, workspaceId, keyed.intent),
          leadTurn: receipt(keyed.intent),
        }
      }
      // Canonical recovery before another admission: the newest retained intent for the exact
      // target context dedupes reload/eviction retries without any client-held request
      // identity. The COMPLETE retained target must match: same session and generation but a
      // different task is a contradictory claim about one context and fails closed, whatever
      // the runtime has done since. A different generation mints anew (ordering, never ground
      // truth: the session host alone knows current generation, and display currency is decided
      // where the live generation is known).
      //
      // The same context admits a successor only after the newest admission's runtime has
      // completed or failed, since only then is nothing left in flight that a second request
      // could duplicate. A running, unknown or cancelling runtime, and an admission whose runtime
      // has not been observed yet, recover the retained request instead.
      //
      // Serialization note: createLeadTurn is the sole inserter and holds the channel FOR UPDATE
      // lock (lockAuthority) before any insert, so concurrent same-target admissions serialize
      // and the loser always finds the winner here; the partial unique target index below is the
      // backstop, not a path with its own recovery.
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
        if (!(await runtimeSettled(tx, retained.id))) {
          assertSameModelSelections(retained, requestedModelSelections)
          return {
            message: await requireIntentMessage(tx, workspaceId, retained),
            leadTurn: receipt(retained),
          }
        }
        targetAttempt = (retained.handoffTargetAttempt ?? 1) + 1
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
              handoffTargetAttempt: targetAttempt,
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

/** Newest retained intent for one complete target context, if any. The partial unique target
 *  index allows one intent per (workspace, channel, session, generation, attempt). */
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
    .orderBy(desc(leadTurnIntents.handoffTargetAttempt))
    .limit(1)
  return retained?.intent
}

/** Whether the intent's runtime has finished for good: completed or failed. */
async function runtimeSettled(tx: AgentHqTransaction, intentId: string): Promise<boolean> {
  const [runtime] = await tx
    .select({ state: leadTurnRuntime.state })
    .from(leadTurnRuntime)
    .where(eq(leadTurnRuntime.intentId, intentId))
  return runtime?.state === 'completed' || runtime?.state === 'failed'
}

/** Explicit choices are identity too: a changed selection must hit the same conflict the
 *  message-idempotency path reports, never a silent return of the old receipt. */
function assertSameModelSelections(
  intent: Intent,
  requested: RequestedRoleModelSelections | undefined
) {
  if (!sameRequestedRoleModelSelections(intent.requestedModelSelections ?? undefined, requested))
    throw new Error('Lead turn model selection conflict')
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

/** Channel summary used only for historical access decisions. */
type HistoricalChannel = Readonly<{
  id: string
  agentId: string | null
  version: number
  lifecycleState: 'active' | 'archived'
}>

type HistoricalAccess =
  | Readonly<{ lifecycleState: 'active'; channel: HistoricalChannel; authority: LockedAuthority }>
  | Readonly<{ lifecycleState: 'archived'; channel: HistoricalChannel }>

/**
 * Current access to archived history (REQ 045). It requires a live workspace membership and a
 * current user participant. Actor-only mutations, such as cancellation, also need the same
 * runtime.invoke permission and audience membership as lockAuthority. It compares no pinned
 * execution state, because archival bumps the channel version. It grants no new effect.
 */
async function lockArchivedAccess(
  tx: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  requireAudienceMemberships: boolean
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
  const participants = await tx
    .select({
      principalKind: channelParticipants.principalKind,
      userId: channelParticipants.userId,
    })
    .from(channelParticipants)
    .where(
      and(
        eq(channelParticipants.workspaceId, workspaceId),
        eq(channelParticipants.channelId, channelId)
      )
    )
    .for('share')
  if (!participants.some((p) => p.principalKind === 'user' && p.userId === principal.userId))
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
}

/**
 * How an existing admission is reached. `read` never admits a group. `bind` writes the canonical
 * dispatch binding and `cancel` requests cancellation; both admit an active group only for its
 * original claim holder, with the full current authority of lockAuthority.
 */
export type HistoricalLeadTurnAccess = 'bind' | 'cancel' | 'read'

/**
 * Canonical historical access for an existing channel. Active direct channels keep their pinned
 * checks: `cancel` requires the full audience and role check, while `read` and `bind` keep the
 * participant check. Archived channels use lockArchivedAccess and are never admissible for a new
 * effect. Archived group admissions are denied for every access.
 */
async function lockHistoricalChannel(
  tx: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  access: HistoricalLeadTurnAccess,
  claimHolderUserId: string | null
): Promise<HistoricalAccess> {
  const [channel] = await tx
    .select({
      id: channels.id,
      kind: channels.kind,
      agentId: channels.agentId,
      taskId: channels.taskId,
      version: channels.version,
      lifecycleState: channels.lifecycleState,
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
  // Group admissions (#1232) are reachable only through `bind` and `cancel`, and only for the original
  // claim holder. An active group then takes the same current authority as an effect (effective
  // admission, live lead, participants, audience and role) through lockAuthority. Reads never reach a
  // group. Archived group admissions stay denied: the archived check pins a direct agent, and no group
  // history rule exists yet.
  if (
    !channel ||
    channel.taskId ||
    (channel.kind !== 'direct_agent' && !(channel.kind === 'group' && access !== 'read'))
  )
    throw new Error('Lead turn unavailable')
  if (
    channel.kind === 'group' &&
    (channel.lifecycleState !== 'active' || claimHolderUserId !== principal.userId)
  )
    throw new Error('Lead turn unavailable')
  const summary: HistoricalChannel = {
    id: channel.id,
    agentId: channel.agentId,
    version: channel.version,
    lifecycleState: channel.lifecycleState,
  }
  const requireAudienceMemberships = access === 'cancel' || channel.kind === 'group'
  if (channel.lifecycleState === 'active') {
    const authority = await lockAuthority(
      tx,
      workspaceId,
      channelId,
      principal,
      requireAudienceMemberships
    )
    return { lifecycleState: 'active', channel: summary, authority }
  }
  await lockArchivedAccess(tx, workspaceId, channelId, principal, access === 'cancel')
  return { lifecycleState: 'archived', channel: summary }
}

/** Pins an active admission to its live authority, or checks an archived admission's channel identity. */
function assertHistoricalIntent(intent: Intent, access: HistoricalAccess) {
  if (access.lifecycleState === 'active') {
    assertPinned(intent, access.authority, false)
    return
  }
  if (access.channel.agentId !== intent.agentId || access.channel.version < intent.channelVersion)
    throw new Error('Lead turn unavailable')
}

/**
 * Addressed dispatch admission for group channels (M15.02, adea-ai/adea#1179).
 * Reuses the canonical admission boundary above — same lockAuthority (with
 * the expected addressed Agent enforced inside the transaction), same
 * freshness gates, same intent shape — but attaches the intent to the
 * ALREADY-STORED human trigger message instead of minting another human
 * message. No body is invented and no content is duplicated: the trigger
 * row stays the single source of content and context, linked by
 * `messageId`. Concurrent first-time admits converge on one row through
 * the message-unique key plus a reselect, exactly like duplicate claims.
 */
export async function admitAddressedLeadTurn(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: Readonly<{
    triggerMessageId: string
    expectedAgentId: string
    requestedModelSelections?: RequestedRoleModelSelections
    /**
     * Coordinator claim this admission serves. When provided, the claim
     * row locks FIRST in this same transaction and must be live
     * (`claimed`/`dispatching`); it flips to `dispatching` and binds the
     * minted intent atomically with it. Terminal transitions and the
     * executable admission therefore share one serialization boundary:
     * a cancel/supersede that commits first wins with zero mint, and one
     * that arrives after loses the row race with zero effect — never a
     * terminal claim with a live uncancelled intent.
     */
    claim?: Readonly<{ id: string }>
  }>,
  options: Readonly<{ clock?: () => string }> = {}
): Promise<{ leadTurn: ReturnType<typeof receipt>; triggerMessageId: string }> {
  const requestedModelSelections = parseRequestedRoleModelSelections(input.requestedModelSelections)
  const clock = options.clock ?? liveLeadClock
  return database.transaction(async (tx) => {
    // Canonical lock order: CHANNEL before claims, everywhere. The human
    // post path holds the channel row across its supersede, so admission
    // takes the same order — never the reverse — and the two serialize
    // instead of deadlocking. Lock modes below do not matter for the
    // order guarantee; first-conflicting-lock-wins decides the sequence.
    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
          eq(channels.lifecycleState, 'active')
        )
      )
      .limit(1)
      .for('update')
    if (!channel) throw new Error('Lead turn unavailable')
    if (input.claim) {
      const [locked] = await tx
        .select()
        .from(addressedAgentTurns)
        .where(
          and(
            eq(addressedAgentTurns.id, input.claim.id),
            eq(addressedAgentTurns.workspaceId, workspaceId)
          )
        )
        .limit(1)
        .for('update')
      // Full claim-to-admission binding: the claim must name this exact
      // channel, this exact trigger, the expected Agent, and an addresser
      // the current principal may act as (addresser or manager).
      // Anything less fails before any authority is read.
      if (
        !locked ||
        locked.channelId !== channelId ||
        locked.triggerMessageId !== input.triggerMessageId ||
        locked.agentId !== input.expectedAgentId ||
        (locked.state !== 'claimed' && locked.state !== 'dispatching')
      )
        throw new Error('Lead turn unavailable')
      if (locked.addresserUserId !== principal.userId) {
        const [membership] = await tx
          .select({ role: workspaceMemberships.role })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspaceId),
              eq(workspaceMemberships.userId, principal.userId)
            )
          )
          .limit(1)
        if (membership?.role !== 'owner' && membership?.role !== 'admin')
          throw new Error('Lead turn unavailable')
      }
    }
    const authority = await lockAuthority(
      tx,
      workspaceId,
      channelId,
      principal,
      true,
      clock,
      input.expectedAgentId
    )
    const [trigger] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.triggerMessageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.channelId, channelId),
          isNull(messages.deletedAt)
        )
      )
      .limit(1)
      .for('share')
    if (!trigger) throw new Error('Lead turn unavailable')
    await assertGroupLeadFreshness(tx, workspaceId, channelId, principal, authority, clock)
    const [existing] = await tx
      .select()
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.messageId, trigger.id))
    if (existing) {
      assertPinned(existing, authority)
      if (
        !sameRequestedRoleModelSelections(
          existing.requestedModelSelections ?? undefined,
          requestedModelSelections
        )
      )
        throw new Error('Lead turn model selection conflict')
      if (input.claim) {
        // Replay binds exactly like insert (gap a): without this, a
        // recovery claim would return an executable intent while leaving
        // intentId null and the claim available for a second dispatch.
        const rebound = await tx
          .update(addressedAgentTurns)
          .set({ intentId: existing.id, state: 'dispatching' })
          .where(
            and(
              eq(addressedAgentTurns.id, input.claim.id),
              eq(addressedAgentTurns.workspaceId, workspaceId),
              sql`${addressedAgentTurns.state} in ('claimed', 'dispatching')`
            )
          )
          .returning({ id: addressedAgentTurns.id })
        if (!rebound[0]) throw new Error('Lead turn unavailable')
      }
      await assertGroupLeadFreshness(tx, workspaceId, channelId, principal, authority, clock)
      return { leadTurn: receipt(existing), triggerMessageId: trigger.id }
    }
    const id = randomUUID()
    const [inserted] = await tx
      .insert(leadTurnIntents)
      .values({
        ...authority,
        id,
        dispatchKey: `lead-turn:${id}`,
        requestedModelSelections: requestedModelSelections ?? null,
        messageId: trigger.id,
        workspaceId,
        channelId,
      })
      .onConflictDoNothing()
      .returning()
    const intent =
      inserted ??
      (await tx.select().from(leadTurnIntents).where(eq(leadTurnIntents.messageId, trigger.id)))[0]
    if (!intent) throw new Error('Lead turn unavailable')
    assertPinned(intent, authority)
    if (input.claim) {
      // Bound on BOTH paths: a replayed intent binds exactly like a fresh
      // one, so a recovery claim never returns an executable intent while
      // leaving intentId null and state claimed.
      const bound = await tx
        .update(addressedAgentTurns)
        .set({ intentId: intent.id, state: 'dispatching' })
        .where(
          and(
            eq(addressedAgentTurns.id, input.claim.id),
            eq(addressedAgentTurns.workspaceId, workspaceId),
            sql`${addressedAgentTurns.state} in ('claimed', 'dispatching')`
          )
        )
        .returning({ id: addressedAgentTurns.id })
      if (!bound[0]) throw new Error('Lead turn unavailable')
    }
    await assertGroupLeadFreshness(tx, workspaceId, channelId, principal, authority, clock)
    return { leadTurn: receipt(intent), triggerMessageId: trigger.id }
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
    // A turn on a message the reader cannot see is unavailable, as the message is.
    if ((await filterVisibleMessageRows(tx, [message], principal.userId)).length === 0)
      throw new Error('Lead turn unavailable')
    const access = await lockHistoricalChannel(
      tx,
      workspaceId,
      message.channelId,
      principal,
      'read',
      null
    )
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
    assertHistoricalIntent(intent, access)
    return receipt(intent)
  })
}

/**
 * Re-reads an intent after its channel authority lock was granted. Under READ COMMITTED a row read
 * before a lock wait can be stale once the wait ends; the writers that change an intent (the
 * rollback fence among them) take the channel lock first, so a read made under that lock sees every
 * committed change. The scope of the row must not have moved.
 */
async function reloadIntentUnderLock(tx: AgentHqTransaction, workspaceId: string, scoped: Intent) {
  const [current] = await tx
    .select()
    .from(leadTurnIntents)
    .where(and(eq(leadTurnIntents.id, scoped.id), eq(leadTurnIntents.workspaceId, workspaceId)))
  if (
    !current ||
    current.channelId !== scoped.channelId ||
    current.actorUserId !== scoped.actorUserId ||
    current.messageId !== scoped.messageId
  )
    throw new Error('Lead turn unavailable')
  return current
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
    const [scoped] = await tx
      .select()
      .from(leadTurnIntents)
      .where(and(eq(leadTurnIntents.id, intentId), eq(leadTurnIntents.workspaceId, workspaceId)))
    if (!scoped || (mutation && scoped.actorUserId !== principal.userId))
      throw new Error('Lead turn unavailable')
    const authority = await lockAuthority(tx, workspaceId, scoped.channelId, principal, mutation)
    // The row above was read before the authority lock was granted, so a rollback fence committed
    // while this transaction waited is not in it. Everything below uses the row read under the lock.
    const intent = await reloadIntentUnderLock(tx, workspaceId, scoped)
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

export type HistoricalLeadTurnChannel = Readonly<{
  id: string
  version: number
  lifecycleState: 'active' | 'archived'
}>

/**
 * Canonical boundary for an existing admission that is read, bound or cancelled. It never admits a
 * new effect. `read` is direct-only. `bind` lets any current direct participant record the dispatch
 * binding, and lets an active group's original claim holder record it with current group authority.
 * `cancel` is the original actor's cancellation, with the same group and audience checks. Archived
 * direct channels stay observable and reconcilable; their new effects remain denied by
 * withAuthorizedLeadTurn.
 */
export async function withHistoricalLeadTurn<T>(
  database: Database,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef,
  purpose: HistoricalLeadTurnAccess,
  operation: (
    tx: AgentHqTransaction,
    intent: Intent,
    message: typeof messages.$inferSelect,
    controlPlaneWorkspaceId: string,
    channel: HistoricalLeadTurnChannel
  ) => Promise<T>
) {
  return database.transaction(async (tx) => {
    const [scoped] = await tx
      .select()
      .from(leadTurnIntents)
      .where(and(eq(leadTurnIntents.id, intentId), eq(leadTurnIntents.workspaceId, workspaceId)))
    if (!scoped || (purpose === 'cancel' && scoped.actorUserId !== principal.userId))
      throw new Error('Lead turn unavailable')
    const access = await lockHistoricalChannel(
      tx,
      workspaceId,
      scoped.channelId,
      principal,
      purpose,
      scoped.actorUserId
    )
    // Reload under the channel lock: a rollback fence committed while this transaction waited for
    // it must be visible to everything the operation reports.
    const intent = await reloadIntentUnderLock(tx, workspaceId, scoped)
    assertHistoricalIntent(intent, access)
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
    // A retained turn on a message the reader cannot see is unavailable, as the message is.
    if ((await filterVisibleMessageRows(tx, [message], principal.userId)).length === 0)
      throw new Error('Lead turn unavailable')
    return operation(tx, intent, message, workspace.id, {
      id: access.channel.id,
      version: access.channel.version,
      lifecycleState: access.channel.lifecycleState,
    })
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
    await lockHistoricalChannel(tx, workspaceId, channelId, principal, 'read', null)
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
    return withHistoricalLeadTurn(
      tx,
      workspaceId,
      latest.id,
      principal,
      'read',
      async (_tx, intent) => receipt(intent)
    )
  })
}
