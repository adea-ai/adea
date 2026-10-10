/*
 * Grant-gated group channels (M15 #1178).
 *
 * This module binds the pure group audience and participation policy
 * (`group-participation-policy`, refs #1178, merged #1192) to durable
 * conversation state. Grants and admissions persist in the
 * `group_audience_grants`, `group_enlistment_grants`, `group_sharing_grants`
 * and `group_admissions` tables, which are the authoritative source every
 * decision authenticates against.
 *
 * Guarantees:
 * - Atomic tenant-bounded creation. `createGroupChannelWithGrants` validates
 *   explicit human audience and Agent enlistment grants before any write,
 *   then commits the channel, grant rows, participant rows, admission rows
 *   and the creation event in one transaction.
 * - Authorized roster management. `setGroupChannelParticipantsWithGrants`
 *   and `revokeGroupGrant` require workspace owner/admin management
 *   authority — workspace membership alone rewrites nothing. A same-workspace
 *   non-manager is denied like a stranger.
 * - Canonical join points. Admissions are read from `group_admissions`
 *   inside the deciding transaction; caller-supplied priors are never
 *   trusted, so a forged or foreign join point authorizes nothing. Retained
 *   members keep their stored join point; newcomers join fail closed at the
 *   channel's current message frontier.
 * - Serialized decisions. The `*Now` helpers and the message read paths load
 *   the gate, the canonical admission, live sharing grants and the frontier
 *   in one transaction and decide there. A concurrent revocation or roster
 *   write lands either before the snapshot (denied) or after it — races fail
 *   closed, never stale-open.
 * - Revocation as a live gate. `revoked_at` denies future reads and turns
 *   immediately and holds late publication; the row and the independently
 *   owned job survive. Regrants bump the revision on the same row, so a
 *   stale retained binding stays held.
 * - Isolation by construction. Group writes fix `kind: 'group'`,
 *   `visibility: 'participants'` and null project/agent bindings, and Agents
 *   resolve only by workspace-qualified identity, never by display name.
 *
 * Turn dispatch and orchestration belong to #1179 and artifact/outbound
 * authorization to #1180; this module only gates (allow/deny/hold) and never
 * dispatches, budgets or loops.
 */
import { randomUUID } from 'node:crypto'

import type {
  ChannelSummary,
  ConversationParticipantRef,
  GroupAdmission,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
  GroupCompletedJob,
  GroupCreationCandidate,
  GroupHistoryEntryRef,
  GroupHistoryReadDecision,
  GroupPublicationDecision,
  GroupPublicationHoldReason,
  GroupSharingGrant,
  GroupSummaryReadDecision,
  GroupTurnDecision,
  MessageSenderRef,
  MessageSummary,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, eq, isNull, max } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { createLeadTurn } from './lead-turns'
import { publishLeadTurnResult } from './lead-turn-runtime'
import type { LeadTurnRuntimeBinding } from './lead-turn-runtime'
import type { RequestedRoleModelSelections } from './lead-model-selections'
import { createMessage, getMessageForUser, listMessagesForUser } from './conversations'
import { validateGroupCreation } from './group-participation-policy'
import {
  admissionForParticipant,
  assertGroupChannelGate,
  authorizeGroupChannelHistoryRead,
  authorizeGroupChannelPublication,
  authorizeGroupChannelSummaryRead,
  authorizeGroupChannelTurn,
  canonicalKey,
  groupCreationPayloadHash,
  GroupCreationError,
  loadGroupAdmission,
  loadGroupRoster,
  loadGroupSharingGrants,
  participantKey,
  requireAgentEnlistmentSource,
  requireGroupManagementAuthority,
  requireGroupMembership,
  requireGroupParticipantLiveness,
  type GroupChannelGate,
} from './group-participation-store'
export {
  ABSENT_GRANT_WINDOW,
  admissionForParticipant,
  admissionFromRow,
  assertGroupChannelGate,
  audienceGrantFromRow,
  authorizeGroupChannelHistoryRead,
  authorizeGroupChannelPublication,
  authorizeGroupChannelSummaryRead,
  authorizeGroupChannelTurn,
  enlistmentGrantFromRow,
  groupCreationCandidatesFromGrants,
  groupCreationPayloadHash,
  GroupCreationError,
  loadGroupAdmission,
  loadGroupRoster,
  loadGroupSharingGrants,
  participantKey,
  partitionGroupChannelHistory,
  requireAgentEnlistmentSource,
  requireGroupManagementAuthority,
  requireGroupMembership,
  requireGroupParticipantLiveness,
  resolveAdmissionWindow,
  resolveGroupLeadAgent,
  sharingGrantFromRow,
  type GroupChannelGate,
  type GroupStoreDatabase,
} from './group-participation-store'
import {
  artifacts,
  channelParticipants,
  channels,
  groupAdmissions,
  groupAudienceGrants,
  groupEnlistmentGrants,
  groupSharingGrants,
  messageArtifactReferences,
} from './schema'
import { leadTurnIntents } from './schema/lead-turns'
import { leadTurnRuntime } from './schema/lead-turn-runtime'
import { appendWorkspaceEvent, inTransaction } from './transactions'

type Database = AgentHqDatabase | AgentHqTransaction
type ChannelRow = typeof channels.$inferSelect

function summarizeGroupChannel(
  row: ChannelRow,
  participants: readonly ConversationParticipantRef[]
): ChannelSummary {
  const ordered = [...participants].toSorted((left, right) =>
    canonicalKey(left).localeCompare(canonicalKey(right))
  )
  return Object.freeze({
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    isPrimaryProjectChannel: row.isPrimaryProjectChannel,
    kind: row.kind,
    lifecycleState: row.lifecycleState,
    participants: Object.freeze(ordered),
    sortOrder: row.sortOrder,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    visibility: row.visibility,
    workspaceId: row.workspaceId,
  })
}

function participantInsert(
  workspaceId: string,
  channelId: string,
  participant: ConversationParticipantRef
) {
  return {
    agentId: participant.kind === 'agent' ? participant.agentId : null,
    channelId,
    principalKind: participant.kind,
    userId: participant.kind === 'user' ? participant.userId : null,
    workspaceId,
  }
}

function admissionInsert(workspaceId: string, channelId: string, admission: GroupAdmission) {
  return {
    agentId: admission.participant.kind === 'agent' ? admission.participant.agentId : null,
    authGrantId: admission.authorization.grantId,
    authGroupId: admission.authorization.groupId,
    authRevision: admission.authorization.revision,
    channelId,
    joinedAt: admission.joinPoint.joinedAt,
    joinedSequence: admission.joinPoint.joinedSequence,
    principalKind: admission.participant.kind,
    userId: admission.participant.kind === 'user' ? admission.participant.userId : null,
    workspaceId,
  }
}

async function persistAudienceGrant(
  database: Database,
  workspaceId: string,
  channelId: string,
  grant: GroupAudienceGrant
) {
  const [existing] = await database
    .select()
    .from(groupAudienceGrants)
    .where(
      and(
        eq(groupAudienceGrants.workspaceId, workspaceId),
        eq(groupAudienceGrants.channelId, channelId),
        eq(groupAudienceGrants.grantId, grant.grantId)
      )
    )
    .limit(1)
  if (!existing) {
    await database.insert(groupAudienceGrants).values({
      channelId,
      expiresAt: grant.expiresAt,
      grantId: grant.grantId,
      issuedAt: grant.issuedAt,
      revision: grant.revision,
      revokedAt: grant.revokedAt,
      userId: grant.participant.userId,
      workspaceId,
    })
    return
  }
  // Monotonic current truth: a regrant with a higher revision supersedes;
  // anything at or below the stored revision keeps the stored row.
  if (grant.revision > existing.revision) {
    await database
      .update(groupAudienceGrants)
      .set({
        expiresAt: grant.expiresAt,
        issuedAt: grant.issuedAt,
        revision: grant.revision,
        revokedAt: grant.revokedAt,
        updatedAt: new Date(),
        userId: grant.participant.userId,
      })
      .where(eq(groupAudienceGrants.id, existing.id))
  }
}

async function persistEnlistmentGrant(
  database: Database,
  workspaceId: string,
  channelId: string,
  grant: GroupAgentEnlistmentGrant
) {
  const [existing] = await database
    .select()
    .from(groupEnlistmentGrants)
    .where(
      and(
        eq(groupEnlistmentGrants.workspaceId, workspaceId),
        eq(groupEnlistmentGrants.channelId, channelId),
        eq(groupEnlistmentGrants.grantId, grant.grantId)
      )
    )
    .limit(1)
  if (!existing) {
    await database.insert(groupEnlistmentGrants).values({
      agentId: grant.agent.agentId,
      channelId,
      expiresAt: grant.expiresAt,
      grantId: grant.grantId,
      issuedAt: grant.issuedAt,
      revision: grant.revision,
      revokedAt: grant.revokedAt,
      workspaceId,
    })
    return
  }
  if (grant.revision > existing.revision) {
    await database
      .update(groupEnlistmentGrants)
      .set({
        agentId: grant.agent.agentId,
        expiresAt: grant.expiresAt,
        issuedAt: grant.issuedAt,
        revision: grant.revision,
        revokedAt: grant.revokedAt,
        updatedAt: new Date(),
      })
      .where(eq(groupEnlistmentGrants.id, existing.id))
  }
}

async function loadChannelGate(
  database: Database,
  workspaceId: string,
  channelId: string,
  options: Readonly<{ forUpdate?: boolean }> = {}
): Promise<GroupChannelGate> {
  const channelQuery = database
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
    .limit(1)
  const [channel] = options.forUpdate ? await channelQuery.for('update') : await channelQuery
  if (!channel || channel.lifecycleState !== 'active') throw new Error('Channel unavailable')
  const participantRows = await database
    .select({
      agentId: channelParticipants.agentId,
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
  const gate: GroupChannelGate = {
    channel: summarizeGroupChannel(
      channel,
      participantRows.map((row): ConversationParticipantRef =>
        row.principalKind === 'user'
          ? { kind: 'user', userId: row.userId! }
          : { agentId: row.agentId!, kind: 'agent' }
      )
    ),
    workspaceId,
  }
  assertGroupChannelGate(gate)
  return gate
}

/**
 * Serialized history decision: gate, canonical admission, live sharing grants
 * and the policy evaluation all see one transaction snapshot, so a concurrent
 * revocation or roster write lands before the snapshot (denied) or after it.
 */
export async function decideGroupChannelHistoryReadNow(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  participant: ConversationParticipantRef,
  entry: GroupHistoryEntryRef,
  now: string
): Promise<GroupHistoryReadDecision> {
  return inTransaction(database, async (transaction) => {
    const gate = await loadChannelGate(transaction, workspaceId, channelId)
    const roster = await loadGroupRoster(transaction, workspaceId, channelId)
    const sharingGrants = await loadGroupSharingGrants(transaction, workspaceId, channelId)
    return authorizeGroupChannelHistoryRead(gate, {
      admission: admissionForParticipant(roster, participant),
      entry,
      now,
      sharingGrants,
    })
  })
}

/** Serialized summary decision; same snapshot discipline as history reads. */
export async function decideGroupChannelSummaryReadNow(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  participant: ConversationParticipantRef,
  fromSequence: number,
  now: string
): Promise<GroupSummaryReadDecision> {
  return inTransaction(database, async (transaction) => {
    const gate = await loadChannelGate(transaction, workspaceId, channelId)
    const roster = await loadGroupRoster(transaction, workspaceId, channelId)
    const sharingGrants = await loadGroupSharingGrants(transaction, workspaceId, channelId)
    return authorizeGroupChannelSummaryRead(gate, {
      admission: admissionForParticipant(roster, participant),
      fromSequence,
      now,
      sharingGrants,
    })
  })
}

/** Serialized turn decision against canonical admission state. */
export async function authorizeGroupChannelTurnNow(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  participant: ConversationParticipantRef,
  now: string
): Promise<GroupTurnDecision> {
  return inTransaction(database, async (transaction) => {
    const gate = await loadChannelGate(transaction, workspaceId, channelId)
    const roster = await loadGroupRoster(transaction, workspaceId, channelId)
    return authorizeGroupChannelTurn(gate, {
      admission: admissionForParticipant(roster, participant),
      now,
    })
  })
}

export type GroupChannelDirectPostInput = Readonly<{
  artifactIds?: readonly string[]
  bodyContentRefId?: string
  bodyText?: string
  executionRef?: string
  externalSessionRef?: string
  idempotencyKey: string
  mentions?: readonly ConversationParticipantRef[]
  replyToMessageId?: string
  taskId?: string
  threadRootMessageId?: string
}>

export type GroupChannelLeadPostInput = Readonly<{
  artifactIds?: readonly string[]
  bodyContentRefId?: string
  bodyText?: string
  idempotencyKey: string
  mentions?: readonly ConversationParticipantRef[]
  /** Explicit lead/child choices, forwarded exactly as the caller stated them. */
  requestedModelSelections?: RequestedRoleModelSelections
}>

export type GroupChannelPostInput =
  | Readonly<{ lead: GroupChannelLeadPostInput; mode: 'lead' }>
  | Readonly<{ message: GroupChannelDirectPostInput; mode: 'direct' }>

/** Test barrier hooks for the post fence; production callers omit them. */
export type GroupPostBarrier = Readonly<{
  afterGate?: () => Promise<void>
}>

/**
 * Trusted time for group boundaries. Production callers omit the clock and
 * read the live wall clock INSIDE the transaction (after locks are held), so
 * a grant expiring while the transaction waited still denies. Tests inject a
 * deterministic sequence. An HTTP caller-supplied instant is NEVER authority:
 * when no clock is given, tests pass an explicit `now` for determinism.
 */
export type GroupClock = () => string

export const liveGroupClock: GroupClock = () => new Date().toISOString()

export type GroupFenceOptions = Readonly<{
  barrier?: GroupPostBarrier
  clock?: GroupClock
  now?: string
}>

/**
 * ONE shared transaction/fence for a group turn and its actual write: the
 * current admission and grant rows are locked and decided here, then the
 * message (direct) or lead turn (nested, savepointed exactly as today) is
 * written in the same transaction. The gate reads trusted time AFTER locks
 * are held, and a FINAL expiry check runs immediately before the nested
 * write, so a grant expiring anywhere in the wait denies and the whole
 * transaction — message, intent, event — rolls back with zero rows written.
 */
export async function postGroupChannelMessageInTransaction<T extends GroupChannelPostInput>(
  transaction: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  sender: MessageSenderRef,
  input: T,
  options: GroupFenceOptions = {}
): Promise<
  T extends Readonly<{ mode: 'lead' }> ? Awaited<ReturnType<typeof createLeadTurn>> : MessageSummary
> {
  const readNow = () => options.clock?.() ?? options.now ?? liveGroupClock()
  // ONE lock order everywhere (channel before admission/grant): the roster
  // rewrite locks the channel row first too, so a concurrent post and
  // rewrite serialize instead of deadlocking.
  const gate = await loadChannelGate(transaction, workspaceId, channelId, { forUpdate: true })
  const participant: ConversationParticipantRef | null =
    sender.kind === 'user'
      ? { kind: 'user', userId: sender.userId }
      : sender.kind === 'agent'
        ? { agentId: sender.agentId, kind: 'agent' }
        : null
  const admission =
    participant === null
      ? null
      : await loadGroupAdmission(transaction, workspaceId, channelId, participant, {
          forUpdate: true,
        })
  const decision = authorizeGroupChannelTurn(gate, { admission, now: readNow() })
  if (decision.action !== 'allow') throw new Error('Channel unavailable')
  await options.barrier?.afterGate?.()
  // Final check re-reads the canonical admission: a removal committed
  // during the wait denies here, before any write runs.
  const current =
    participant === null
      ? null
      : await loadGroupAdmission(transaction, workspaceId, channelId, participant, {
          forUpdate: true,
        })
  const final = authorizeGroupChannelTurn(gate, { admission: current, now: readNow() })
  if (final.action !== 'allow') throw new Error('Channel unavailable')
  if (input.mode === 'lead') {
    const lead = (input as Readonly<{ lead: GroupChannelLeadPostInput; mode: 'lead' }>).lead
    const posted = await createLeadTurn(transaction, workspaceId, channelId, principal, lead, {
      clock: options.clock ?? liveGroupClock,
    })
    // Post-write check re-reads too: removal or revocation during the
    // awaited write denies and rolls back ALL effects with zero rows.
    const settledLead =
      participant === null
        ? null
        : await loadGroupAdmission(transaction, workspaceId, channelId, participant, {
            forUpdate: true,
          })
    const settled = authorizeGroupChannelTurn(gate, { admission: settledLead, now: readNow() })
    if (settled.action !== 'allow') throw new Error('Channel unavailable')
    return posted as T extends Readonly<{ mode: 'lead' }>
      ? Awaited<ReturnType<typeof createLeadTurn>>
      : MessageSummary
  }
  const direct = (input as Readonly<{ message: GroupChannelDirectPostInput; mode: 'direct' }>)
    .message
  const posted = await createMessage(transaction, workspaceId, channelId, principal, {
    ...direct,
    sender,
  })
  const settledDirect =
    participant === null
      ? null
      : await loadGroupAdmission(transaction, workspaceId, channelId, participant, {
          forUpdate: true,
        })
  const settled = authorizeGroupChannelTurn(gate, { admission: settledDirect, now: readNow() })
  if (settled.action !== 'allow') throw new Error('Channel unavailable')
  return posted as T extends Readonly<{ mode: 'lead' }>
    ? Awaited<ReturnType<typeof createLeadTurn>>
    : MessageSummary
}

/** Fenced group post: gate and write share one transaction (see above). */
export async function postGroupChannelMessage<T extends GroupChannelPostInput>(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  sender: MessageSenderRef,
  input: T,
  options: GroupFenceOptions = {}
): Promise<
  T extends Readonly<{ mode: 'lead' }> ? Awaited<ReturnType<typeof createLeadTurn>> : MessageSummary
> {
  return database.transaction((transaction) =>
    postGroupChannelMessageInTransaction(
      transaction,
      workspaceId,
      channelId,
      principal,
      sender,
      input,
      options
    )
  )
}

/**
 * Live-clock publication decision for a completed group job. Loads the gate
 * and the canonical roster in one transaction and evaluates on trusted time
 * (injected clock, explicit instant, else the live wall clock), so a grant
 * expiring while the read waited still holds. Read-only: a hold carries no
 * write to roll back, and the independently owned job is untouched.
 */
export async function decideGroupChannelPublicationNow(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  job: GroupCompletedJob,
  publisher: ConversationParticipantRef,
  options: GroupFenceOptions = {}
): Promise<GroupPublicationDecision> {
  return inTransaction(database, async (transaction) => {
    const gate = await loadChannelGate(transaction, workspaceId, channelId)
    const roster = await loadGroupRoster(transaction, workspaceId, channelId)
    const now = options.clock?.() ?? options.now ?? liveGroupClock()
    return authorizeGroupChannelPublication(gate, {
      admission: admissionForParticipant(roster, publisher),
      job,
      now,
      publisher,
    })
  })
}

/**
 * Join-point-filtered message history for one group channel. Enforcement
 * lives in the shared read (`listMessagesForUser`); this wrapper pins the
 * group and passes the decision instant through. Hidden earlier entries can
 * shorten a page, so clients keep paging with `nextAfterSequence`.
 */
export async function listGroupChannelMessagesForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ afterSequence?: number; limit?: number; threadRootMessageId?: string }>,
  fence: GroupFenceOptions = {}
) {
  const instant = fence.clock ? fence.clock() : fence.now
  return listMessagesForUser(database, workspaceId, channelId, principal, {
    ...options,
    ...(instant === undefined ? null : { now: instant }),
  })
}

/**
 * One group message through the shared read: a denied entry answers exactly
 * like a missing one, so the gate is not a history oracle.
 */
export async function getGroupMessageForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  messageId: string,
  principal: UserPrincipalRef,
  fence: GroupFenceOptions = {}
): Promise<MessageSummary> {
  const instant = fence.clock ? fence.clock() : fence.now
  const message = await getMessageForUser(
    database,
    workspaceId,
    messageId,
    principal,
    instant === undefined ? {} : { now: instant }
  )
  if (message.channelId !== channelId) throw new Error('Message unavailable')
  return message
}

async function nextGroupChannelSortOrder(database: Database, workspaceId: string) {
  const [position] = await database
    .select({ value: max(channels.sortOrder) })
    .from(channels)
    .where(eq(channels.workspaceId, workspaceId))
  return (position?.value ?? -1) + 1
}

export type GroupChannelCreateInput = Readonly<{
  candidates: readonly GroupCreationCandidate[]
  /** Pre-generated channel id; grants must already be bound to it. Defaults to a fresh UUID. */
  channelId?: string
  idempotencyKey: string
  now: string
  title: string
}>

/**
 * Atomically create a tenant-bounded group with explicit human audience and
 * Agent enlistment grants. Validation runs before any write: a rejected
 * roster throws `GroupCreationError` with zero database writes. A validated
 * roster commits the channel, grant rows, participant rows, canonical
 * admission rows and the creation event in one transaction. An idempotent
 * replay returns the existing channel with its persisted canonical roster.
 */
export async function createGroupChannelWithGrants(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: GroupChannelCreateInput
): Promise<{ channel: ChannelSummary; roster: readonly GroupAdmission[] }> {
  const idempotencyKey = input.idempotencyKey.trim()
  const title = input.title.trim()
  if (!idempotencyKey || idempotencyKey.length > 128 || !title || input.title.length > 120)
    throw new Error('Invalid group request')
  const channelId = input.channelId ?? randomUUID()
  const validation = validateGroupCreation({
    candidates: input.candidates,
    groupId: channelId,
    now: input.now,
    workspaceId,
  })
  if (!validation.ok) throw new GroupCreationError(validation.rejections)
  const roster = validation.roster
  const payloadHash = groupCreationPayloadHash(title, workspaceId, roster)

  return database.transaction(async (transaction) => {
    await requireGroupMembership(transaction, workspaceId, principal)
    // Standing is proven per authority: humans through host membership,
    // Agents through their own source workspace (never host equality).
    for (const [candidateIndex, candidate] of input.candidates.entries()) {
      if (candidate.kind === 'human')
        await requireGroupParticipantLiveness(transaction, workspaceId, candidate.participant)
      else
        await requireAgentEnlistmentSource(
          transaction,
          candidateIndex,
          candidate.agentId,
          candidate.workspaceId
        )
    }
    // No conflict arbiter: concurrent retries carry the same explicit id,
    // so the primary key itself can collide before the idempotency key is
    // visible. Any conflict falls through to the replay path, which loads
    // the existing row and accepts only an identical payload.
    const [created] = await transaction
      .insert(channels)
      .values({
        createPayloadHash: payloadHash,
        id: channelId,
        idempotencyKey,
        kind: 'group',
        sortOrder: await nextGroupChannelSortOrder(transaction, workspaceId),
        title,
        visibility: 'participants',
        workspaceId,
      })
      .onConflictDoNothing()
      .returning()
    if (!created) {
      const [existing] = await transaction
        .select()
        .from(channels)
        .where(
          and(eq(channels.workspaceId, workspaceId), eq(channels.idempotencyKey, idempotencyKey))
        )
        .limit(1)
      if (!existing || existing.kind !== 'group' || existing.createPayloadHash !== payloadHash)
        throw new Error('Channel idempotency conflict')
      const gate = await loadChannelGate(transaction, workspaceId, existing.id)
      const persisted = await loadGroupRoster(transaction, workspaceId, existing.id)
      return { channel: gate.channel, roster: persisted }
    }
    for (const candidate of input.candidates) {
      if (candidate.kind === 'human') {
        if (!candidate.audienceGrant) throw new Error('Group grant missing after validation')
        await persistAudienceGrant(transaction, workspaceId, created.id, candidate.audienceGrant)
      } else {
        if (!candidate.enlistmentGrant) throw new Error('Group grant missing after validation')
        await persistEnlistmentGrant(
          transaction,
          workspaceId,
          created.id,
          candidate.enlistmentGrant
        )
      }
    }
    await transaction
      .insert(channelParticipants)
      .values(
        roster.map((admission) => participantInsert(workspaceId, created.id, admission.participant))
      )
    await transaction
      .insert(groupAdmissions)
      .values(roster.map((admission) => admissionInsert(workspaceId, created.id, admission)))
    await appendWorkspaceEvent(transaction, {
      eventType: 'channel.created',
      payload: { actorUserId: principal.userId, channelId: created.id, kind: 'group' },
      workspaceId,
    })
    return {
      channel: summarizeGroupChannel(
        created,
        roster.map((admission) => admission.participant)
      ),
      roster,
    }
  })
}

export type GroupChannelSetParticipantsInput = Readonly<{
  candidates: readonly GroupCreationCandidate[]
  expectedVersion: number
  now: string
}>

/**
 * Grant-gated roster replacement for one group channel in a single
 * transaction with optimistic concurrency. Management authority (workspace
 * owner/admin) is required — same-workspace membership alone is denied.
 * Every listed participant must present an effective explicit grant. Join
 * points come from canonical stored admissions: retained members keep theirs,
 * newcomers join fail closed at the channel's current message frontier, so a
 * roster write never over-grants earlier history and no caller-supplied prior
 * is ever trusted.
 */
export async function setGroupChannelParticipantsWithGrants(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: GroupChannelSetParticipantsInput
): Promise<{ channel: ChannelSummary; roster: readonly GroupAdmission[] }> {
  const validation = validateGroupCreation({
    candidates: input.candidates,
    groupId: channelId,
    now: input.now,
    workspaceId,
  })
  if (!validation.ok) throw new GroupCreationError(validation.rejections)
  return database.transaction((transaction) =>
    setGroupChannelParticipantsInTransaction(transaction, workspaceId, channelId, principal, {
      candidates: input.candidates,
      expectedVersion: input.expectedVersion,
      now: input.now,
      roster: validation.roster,
    })
  )
}

/** Test barrier hooks for the roster rewrite; production callers omit them. */
export type GroupRosterBarrier = Readonly<{
  afterChannelLock?: () => Promise<void>
}>

/**
 * Roster-rewrite core inside the caller's transaction. Holds the channel row
 * lock across the frontier read and the admission writes; a barrier hook
 * lets parked race tests observe the locked window deterministically.
 */
export async function setGroupChannelParticipantsInTransaction(
  transaction: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  validated: Readonly<{
    candidates: readonly GroupCreationCandidate[]
    expectedVersion: number
    now: string
    roster: readonly GroupAdmission[]
  }>,
  barrier: GroupRosterBarrier = {}
): Promise<{ channel: ChannelSummary; roster: readonly GroupAdmission[] }> {
  await requireGroupManagementAuthority(transaction, workspaceId, principal)
  const [channel] = await transaction
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
    .limit(1)
    .for('update')
  if (!channel || channel.kind !== 'group' || channel.lifecycleState !== 'active')
    throw new Error('Channel unavailable')
  // The row lock serializes the frontier read below against concurrent
  // message writers (their channel-sequence advance updates this row), so
  // a newcomer join point always lands after every committed message.
  await barrier.afterChannelLock?.()
  if (channel.version !== validated.expectedVersion) throw new Error('Channel version conflict')
  for (const [candidateIndex, candidate] of validated.candidates.entries()) {
    if (candidate.kind === 'human')
      await requireGroupParticipantLiveness(transaction, workspaceId, candidate.participant)
    else
      await requireAgentEnlistmentSource(
        transaction,
        candidateIndex,
        candidate.agentId,
        candidate.workspaceId
      )
  }
  const stored = await loadGroupRoster(transaction, workspaceId, channelId)
  const storedByParticipant = new Map(
    stored.map((admission) => [participantKey(workspaceId, admission.participant), admission])
  )
  const frontier = channel.latestMessageSequence
  const roster = validated.roster.map((admission) => {
    const canonical = storedByParticipant.get(participantKey(workspaceId, admission.participant))
    if (canonical) return { ...admission, joinPoint: canonical.joinPoint }
    // Strictly after the observed frontier: the decision allows sequences
    // at or after the join point, so joining AT the frontier would leak the
    // boundary message posted before admission.
    return { ...admission, joinPoint: { joinedAt: validated.now, joinedSequence: frontier + 1 } }
  })
  for (const candidate of validated.candidates) {
    if (candidate.kind === 'human') {
      if (!candidate.audienceGrant) throw new Error('Group grant missing after validation')
      await persistAudienceGrant(transaction, workspaceId, channelId, candidate.audienceGrant)
    } else {
      if (!candidate.enlistmentGrant) throw new Error('Group grant missing after validation')
      await persistEnlistmentGrant(transaction, workspaceId, channelId, candidate.enlistmentGrant)
    }
  }
  await transaction
    .delete(channelParticipants)
    .where(
      and(
        eq(channelParticipants.workspaceId, workspaceId),
        eq(channelParticipants.channelId, channelId)
      )
    )
  if (roster.length > 0)
    await transaction
      .insert(channelParticipants)
      .values(
        roster.map((admission) => participantInsert(workspaceId, channelId, admission.participant))
      )
  await transaction
    .delete(groupAdmissions)
    .where(
      and(eq(groupAdmissions.workspaceId, workspaceId), eq(groupAdmissions.channelId, channelId))
    )
  if (roster.length > 0)
    await transaction
      .insert(groupAdmissions)
      .values(roster.map((admission) => admissionInsert(workspaceId, channelId, admission)))
  const [updated] = await transaction
    .update(channels)
    .set({ updatedAt: new Date(), version: channel.version + 1 })
    .where(
      and(
        eq(channels.id, channelId),
        eq(channels.workspaceId, workspaceId),
        eq(channels.version, validated.expectedVersion)
      )
    )
    .returning()
  if (!updated) throw new Error('Channel version conflict')
  return {
    channel: summarizeGroupChannel(
      updated,
      roster.map((admission) => admission.participant)
    ),
    roster,
  }
}

export type GroupGrantKind = 'audience' | 'enlistment' | 'sharing'

/**
 * Revoke one persisted grant effective immediately. Requires group-management
 * authority. The row survives with its revocation instant, so future reads
 * and turns deny at once while late publication holds and the independently
 * owned job is untouched. Revoking an already-revoked grant reports
 * `revoked: false` and changes nothing.
 */
export async function revokeGroupGrant(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ grantId: string; kind: GroupGrantKind; revokedAt: string }>
): Promise<{ revoked: boolean }> {
  return database.transaction(async (transaction) => {
    await requireGroupManagementAuthority(transaction, workspaceId, principal)
    const [channel] = await transaction
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
      .limit(1)
    if (!channel || !input.grantId.trim()) throw new Error('Channel unavailable')
    const table =
      input.kind === 'audience'
        ? groupAudienceGrants
        : input.kind === 'enlistment'
          ? groupEnlistmentGrants
          : groupSharingGrants
    const [revoked] = await transaction
      .update(table)
      .set({ revokedAt: input.revokedAt, updatedAt: new Date() })
      .where(
        and(
          eq(table.workspaceId, workspaceId),
          eq(table.channelId, channelId),
          eq(table.grantId, input.grantId),
          isNull(table.revokedAt)
        )
      )
      .returning({ id: table.id })
    if (revoked) return { revoked: true }
    const [existing] = await transaction
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.workspaceId, workspaceId),
          eq(table.channelId, channelId),
          eq(table.grantId, input.grantId)
        )
      )
      .limit(1)
    if (!existing) throw new Error('Grant unavailable')
    return { revoked: false }
  })
}

/**
 * Persist an audience-aware sharing grant for earlier history or summaries.
 * Requires group-management authority and a live grant window; the grant
 * authorizes earlier material only for its exact participant and scope, in
 * the group it names. A higher revision supersedes; anything at or below the
 * stored revision keeps the stored row.
 */
export async function shareGroupHistory(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  grant: GroupSharingGrant
): Promise<void> {
  if (grant.groupId !== channelId) throw new Error('Invalid group request')
  await database.transaction(async (transaction) => {
    await requireGroupManagementAuthority(transaction, workspaceId, principal)
    const [channel] = await transaction
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
      .limit(1)
    if (!channel) throw new Error('Channel unavailable')
    const [existing] = await transaction
      .select()
      .from(groupSharingGrants)
      .where(
        and(
          eq(groupSharingGrants.workspaceId, workspaceId),
          eq(groupSharingGrants.channelId, channelId),
          eq(groupSharingGrants.grantId, grant.grantId)
        )
      )
      .limit(1)
    if (!existing) {
      await transaction.insert(groupSharingGrants).values({
        agentId: grant.participant.kind === 'agent' ? grant.participant.agentId : null,
        channelId,
        expiresAt: grant.expiresAt,
        grantId: grant.grantId,
        issuedAt: grant.issuedAt,
        principalKind: grant.participant.kind,
        revision: grant.revision,
        revokedAt: grant.revokedAt,
        scope: grant.scope,
        userId: grant.participant.kind === 'user' ? grant.participant.userId : null,
        workspaceId,
      })
      return
    }
    if (grant.revision > existing.revision) {
      await transaction
        .update(groupSharingGrants)
        .set({
          agentId: grant.participant.kind === 'agent' ? grant.participant.agentId : null,
          expiresAt: grant.expiresAt,
          issuedAt: grant.issuedAt,
          principalKind: grant.participant.kind,
          revision: grant.revision,
          revokedAt: grant.revokedAt,
          scope: grant.scope,
          updatedAt: new Date(),
          userId: grant.participant.kind === 'user' ? grant.participant.userId : null,
        })
        .where(eq(groupSharingGrants.id, existing.id))
    }
  })
}

/** A held group publication, carrying the typed reason instead of failing silently. */
export class GroupPublicationHoldError extends Error {
  readonly reason: GroupPublicationHoldReason

  constructor(reason: GroupPublicationHoldReason) {
    super(`Group publication held: ${reason}`)
    this.name = 'GroupPublicationHoldError'
    this.reason = reason
  }
}

export type GroupLeadPublicationInput = Readonly<{
  /** Opaque runtime binding, forwarded verbatim to the job-outbound service. */
  binding: LeadTurnRuntimeBinding
  /** Exact destination channel: must equal the job's canonical channel. */
  channelId: string
  /** Canonical job: the retained lead-turn intent id. */
  intentId: string
  /** Result text for the audience-authorized projection. */
  bodyText: string
}>

/**
 * Result/artifact projection gate: every artifact linked to the job's
 * source message must resolve to a live, workspace-bound row. A claimed link
 * with no readable row fails closed — it never passes as artifact-free.
 * Workspace-scoped like the group audience itself; project-scoped artifact
 * authorization stays with the artifact lanes.
 */
async function requireGroupResultArtifacts(
  database: Database,
  workspaceId: string,
  messageId: string,
  options: Readonly<{ forUpdate?: boolean }> = {}
): Promise<void> {
  const links = await database
    .select({ artifactId: messageArtifactReferences.artifactId })
    .from(messageArtifactReferences)
    .where(eq(messageArtifactReferences.messageId, messageId))
  for (const link of links) {
    const query = database
      .select({ deletionState: artifacts.deletionState })
      .from(artifacts)
      .where(and(eq(artifacts.id, link.artifactId), eq(artifacts.workspaceId, workspaceId)))
      .limit(1)
    const [row] = options.forUpdate ? await query.for('update') : await query
    if (!row || row.deletionState !== 'active')
      throw new Error('Group publication artifact unresolved')
  }
}

/**
 * Publish a completed group lead job through the existing job-outbound
 * service (`publishLeadTurnResult`, owned with #1217) — no competing store
 * or outbox. Before invoking, this caller binds, from canonical rows: the
 * job (retained intent), the original actor (publisher must be the intent's
 * actor), the accepted group revision (the publisher's current admission
 * binding, bound to the destination channel), the exact destination channel
 * (must equal the intent's channel, and be a group), and the
 * audience-authorized projection (the publisher's participation must be
 * effective at completion and now). The SAME frozen job snapshot is then
 * re-decided inside the service's canonical locks via the check closure, so
 * a roster mutation between binding and publication lands as a typed hold
 * instead of publishing under superseded authority. Group membership never
 * implies source authority and vice versa: each is checked on its own rows.
 */
export async function publishGroupLeadResult(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: GroupLeadPublicationInput,
  options: GroupFenceOptions & Readonly<{ beforeService?: () => Promise<void> }> = {}
): Promise<string> {
  const now = options.clock?.() ?? options.now ?? liveGroupClock()
  const [intent] = await database
    .select()
    .from(leadTurnIntents)
    .where(
      and(eq(leadTurnIntents.id, input.intentId), eq(leadTurnIntents.workspaceId, workspaceId))
    )
    .limit(1)
  if (!intent || intent.channelId !== input.channelId) throw new Error('Channel unavailable')
  const publisher: ConversationParticipantRef = { kind: 'user', userId: principal.userId }
  if (intent.actorUserId !== principal.userId)
    throw new GroupPublicationHoldError('publication_authority_mismatch')
  const bound = await inTransaction(database, async (transaction) => {
    const gate = await loadChannelGate(transaction, workspaceId, input.channelId, {
      forUpdate: true,
    })
    const roster = await loadGroupRoster(transaction, workspaceId, input.channelId, {
      forUpdate: true,
    })
    const admission = admissionForParticipant(roster, publisher)
    if (!admission) throw new GroupPublicationHoldError('publication_unauthorized_at_completion')
    const [runtime] = await transaction
      .select({ observedAt: leadTurnRuntime.observedAt })
      .from(leadTurnRuntime)
      .where(eq(leadTurnRuntime.intentId, intent.id))
      .limit(1)
    const job: GroupCompletedJob = {
      authorization: admission.authorization,
      completedAt: runtime?.observedAt?.toISOString() ?? now,
      jobId: intent.id,
      participant: publisher,
    }
    const decision = authorizeGroupChannelPublication(gate, {
      admission,
      job,
      now,
      publisher,
    })
    if (decision.action !== 'publish') throw new GroupPublicationHoldError(decision.reason)
    await requireGroupResultArtifacts(transaction, workspaceId, intent.messageId)
    return job
  })
  await options.beforeService?.()
  return publishLeadTurnResult(
    database,
    workspaceId,
    intent.id,
    principal,
    input.binding,
    input.bodyText,
    async () => {
      // Plain reads by design: the service transaction already holds the
      // admission/grant locks through its own authority check, so
      // re-locking them here deadlocked this check against the service. A
      // concurrent revocation still orders outside the service transaction,
      // and expiry is covered by the fresh trusted instant below.
      const freshNow = options.clock?.() ?? options.now ?? liveGroupClock()
      const gate = await loadChannelGate(database, workspaceId, input.channelId)
      const roster = await loadGroupRoster(database, workspaceId, input.channelId)
      const decision = authorizeGroupChannelPublication(gate, {
        admission: admissionForParticipant(roster, publisher),
        job: bound,
        now: freshNow,
        publisher,
      })
      if (decision.action !== 'publish') throw new GroupPublicationHoldError(decision.reason)
      await requireGroupResultArtifacts(database, workspaceId, intent.messageId, {
        forUpdate: true,
      })
    }
  )
}
