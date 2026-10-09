/*
 * Grant-gated group channels (M15 #1178).
 *
 * This module binds the pure group audience and participation policy
 * (`group-participation-policy`, refs #1178, merged #1192) to the live
 * conversation store. It performs I/O only through the existing
 * `channels` and `channelParticipants` tables: no migration, no new tables,
 * no route or dispatch changes.
 *
 * What it provides:
 * - Atomic tenant-bounded creation. `createGroupChannelWithGrants` validates
 *   the caller-supplied explicit human audience and Agent enlistment grants
 *   with `validateGroupCreation` before touching the database, then creates
 *   the group channel and its full roster in one transaction. Any invalid
 *   participant fails the whole creation with typed rejections and zero
 *   writes; any insert failure rolls the channel back with it. There is no
 *   partial roster, ever.
 * - Grant-gated roster replacement. `setGroupChannelParticipantsWithGrants`
 *   revalidates every listed participant's explicit grant in one transaction
 *   with optimistic concurrency. Newcomers join at the channel's current
 *   message frontier; retained members keep their caller-supplied prior join
 *   point, defaulting fail closed to the frontier when unknown, so earlier
 *   history is never over-granted by a roster write.
 * - Snapshot-bound reads, turns and publication. The `authorize*` helpers pin
 *   every decision to the live channel (`groupId` is always the channel id,
 *   never caller-supplied), assert group isolation first, and delegate to the
 *   pure decisions. A foreign group's admission or sharing grant authorizes
 *   nothing here. Revocation denies future reads and turns immediately and
 *   holds late publication; a hold never cancels or reassigns the
 *   independently owned job.
 * - Isolation by construction. Group writes fix `kind: 'group'`,
 *   `visibility: 'participants'` and null project/agent bindings, so
 *   conversation membership never grants workspace or tool authority, and
 *   Agents are always resolved by their workspace-qualified identity, never
 *   by display name.
 *
 * Deliberately out of scope (documented gaps, not silent):
 * - Durable grant and join-point storage. Grants are caller-supplied and
 *   validated in memory; admissions are returned values the caller retains.
 *   Persisting grant rows and join points (a migration with grant/admission
 *   tables) is the follow-up slice, as is wiring these gates into the HTTP
 *   routes and the turn coordinator (#1179 owns turn dispatch, #1180 owns
 *   artifact/outbound authorization).
 * - Revocation between validation and commit closes at use time: every
 *   read/turn/publication decision re-evaluates the live grant window, so a
 *   grant revoked after admission still denies immediately.
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
  GroupCreationRejection,
  GroupHistoryEntryRef,
  GroupHistoryReadDecision,
  GroupPublicationDecision,
  GroupSharingGrant,
  GroupSummaryReadDecision,
  GroupTurnDecision,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, eq, max } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  decideGroupHistoryRead,
  decideGroupPublication,
  decideGroupSummaryRead,
  decideGroupTurn,
  validateGroupCreation,
} from './group-participation-policy'
import { agents, channelParticipants, channels, workspaceMemberships } from './schema'
import { appendWorkspaceEvent } from './transactions'

type Database = AgentHqDatabase | AgentHqTransaction
type ChannelRow = typeof channels.$inferSelect

/** The live channel a group decision is pinned to. */
export type GroupChannelGate = Readonly<{ channel: ChannelSummary; workspaceId: string }>

export class GroupCreationError extends Error {
  readonly rejections: readonly GroupCreationRejection[]

  constructor(rejections: readonly GroupCreationRejection[]) {
    super('Group creation rejected: every participant requires a valid explicit grant')
    this.name = 'GroupCreationError'
    this.rejections = rejections
  }
}

function canonicalKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalKey(entry)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function sameParticipant(
  left: ConversationParticipantRef,
  right: ConversationParticipantRef
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'user' && right.kind === 'user') return left.userId === right.userId
  if (left.kind === 'agent' && right.kind === 'agent') return left.agentId === right.agentId
  return false
}

function participantKey(workspaceId: string, participant: ConversationParticipantRef): string {
  return participant.kind === 'user'
    ? `user:${participant.userId}`
    : `agent:${workspaceId}:${participant.agentId}`
}

/**
 * Build creation candidates from explicit grants. Human candidates resolve in
 * the owning workspace; Agent candidates resolve in their grant's workspace,
 * so a cross-tenant grant reaches the policy as a typed
 * `participant_cross_tenant` rejection instead of being silently dropped.
 */
export function groupCreationCandidatesFromGrants(
  workspaceId: string,
  grants: Readonly<{
    audienceGrants: readonly GroupAudienceGrant[]
    enlistmentGrants: readonly GroupAgentEnlistmentGrant[]
  }>
): GroupCreationCandidate[] {
  return [
    ...grants.audienceGrants.map((audienceGrant): GroupCreationCandidate => ({
      audienceGrant,
      kind: 'human',
      participant: audienceGrant.participant,
      workspaceId,
    })),
    ...grants.enlistmentGrants.map((enlistmentGrant): GroupCreationCandidate => ({
      agentId: enlistmentGrant.agent.agentId,
      enlistmentGrant,
      kind: 'agent',
      workspaceId: enlistmentGrant.agent.workspaceId,
    })),
  ]
}

/** The validated roster's standing for one participant, or null when never admitted. */
export function admissionForParticipant(
  roster: readonly GroupAdmission[],
  participant: ConversationParticipantRef
): GroupAdmission | null {
  return roster.find((admission) => sameParticipant(admission.participant, participant)) ?? null
}

/**
 * Group isolation: a group decision runs only against a participants-scoped
 * group channel with no project or Agent binding, in the owning workspace.
 * Anything else — project lanes, direct Agent topics, workspace-visible
 * channels, foreign workspaces — is answered like a missing channel, so
 * group authority can never leak into workspace tool authority and private
 * direct chats never become group content.
 */
export function assertGroupChannelGate(gate: GroupChannelGate): void {
  const { channel, workspaceId } = gate
  if (
    channel.workspaceId !== workspaceId ||
    channel.kind !== 'group' ||
    channel.visibility !== 'participants' ||
    channel.projectId !== undefined ||
    channel.agentId !== undefined
  )
    throw new Error('Channel unavailable')
}

/** Join-point history plus authorized earlier sharing, pinned to the live channel. */
export function authorizeGroupChannelHistoryRead(
  gate: GroupChannelGate,
  input: Readonly<{
    admission: GroupAdmission | null
    entry: GroupHistoryEntryRef
    now: string
    sharingGrants: readonly GroupSharingGrant[]
  }>
): GroupHistoryReadDecision {
  assertGroupChannelGate(gate)
  return decideGroupHistoryRead({
    admission: input.admission,
    entry: input.entry,
    groupId: gate.channel.id,
    now: input.now,
    sharingGrants: input.sharingGrants,
  })
}

/** Authorized summaries, pinned to the live channel. */
export function authorizeGroupChannelSummaryRead(
  gate: GroupChannelGate,
  input: Readonly<{
    admission: GroupAdmission | null
    fromSequence: number
    now: string
    sharingGrants: readonly GroupSharingGrant[]
  }>
): GroupSummaryReadDecision {
  assertGroupChannelGate(gate)
  return decideGroupSummaryRead({
    admission: input.admission,
    fromSequence: input.fromSequence,
    groupId: gate.channel.id,
    now: input.now,
    sharingGrants: input.sharingGrants,
  })
}

/** Turns require an effective participation grant at `now`, pinned to the live channel. */
export function authorizeGroupChannelTurn(
  gate: GroupChannelGate,
  input: Readonly<{ admission: GroupAdmission | null; now: string }>
): GroupTurnDecision {
  assertGroupChannelGate(gate)
  return decideGroupTurn({
    admission: input.admission,
    groupId: gate.channel.id,
    now: input.now,
  })
}

/**
 * The publication gate for a completed job, pinned to the live channel. An
 * admission or a job bound to another group is held with
 * `publication_binding_mismatch` before the pure comparison runs, so a
 * foreign pair that matches each other can never publish here. A hold keeps
 * one result out of the group and says nothing about the independently owned
 * job, which is never cancelled or reassigned.
 */
export function authorizeGroupChannelPublication(
  gate: GroupChannelGate,
  input: Readonly<{
    admission: GroupAdmission | null
    job: GroupCompletedJob
    now: string
    publisher: ConversationParticipantRef
  }>
): GroupPublicationDecision {
  assertGroupChannelGate(gate)
  const { admission, job } = input
  if (
    !admission ||
    admission.authorization.groupId !== gate.channel.id ||
    (job.authorization !== null && job.authorization.groupId !== gate.channel.id)
  )
    return { action: 'hold', jobId: job.jobId, reason: 'publication_binding_mismatch' }
  return decideGroupPublication({
    admission,
    job,
    now: input.now,
    publisher: input.publisher,
  })
}

/**
 * Split already-fetched channel entries into the reader's visible history and
 * the held earlier history. Order is preserved on both sides. Live read-path
 * wiring (routes) is a follow-up; this pure partition is the unit under test.
 */
export function partitionGroupChannelHistory(
  gate: GroupChannelGate,
  input: Readonly<{
    admission: GroupAdmission | null
    entries: readonly GroupHistoryEntryRef[]
    now: string
    sharingGrants: readonly GroupSharingGrant[]
  }>
): { hidden: GroupHistoryEntryRef[]; visible: GroupHistoryEntryRef[] } {
  const visible: GroupHistoryEntryRef[] = []
  const hidden: GroupHistoryEntryRef[] = []
  for (const entry of input.entries) {
    const decision = authorizeGroupChannelHistoryRead(gate, {
      admission: input.admission,
      entry,
      now: input.now,
      sharingGrants: input.sharingGrants,
    })
    if (decision.action === 'allow') visible.push(entry)
    else hidden.push(entry)
  }
  return { hidden, visible }
}

async function requireGroupMembership(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  const [membership] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!membership) throw new Error('Channel unavailable')
}

async function requireGroupParticipantLiveness(
  database: Database,
  workspaceId: string,
  participant: ConversationParticipantRef
) {
  if (participant.kind === 'user') {
    const [membership] = await database
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.userId, participant.userId)
        )
      )
      .limit(1)
    if (!membership) throw new Error('Conversation participant unavailable')
    return
  }
  const [agent] = await database
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, participant.agentId),
        eq(agents.workspaceId, workspaceId),
        eq(agents.lifecycleState, 'active')
      )
    )
    .limit(1)
  if (!agent) throw new Error('Agent unavailable')
}

/**
 * The idempotency identity of a grant-validated creation: title plus the
 * sorted retained bindings and participant keys. A replay with the same key
 * and payload returns the existing channel; any difference is a conflict,
 * never a silent relabel.
 */
export function groupCreationPayloadHash(
  title: string,
  workspaceId: string,
  roster: readonly GroupAdmission[]
): string {
  return canonicalKey({
    bindings: roster
      .map((admission) => ({
        authorization: admission.authorization,
        participant: admission.participant,
      }))
      .toSorted((left, right) => canonicalKey(left).localeCompare(canonicalKey(right))),
    title: title.trim(),
    workspaceId,
  })
}

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

type GroupParticipantInsert = {
  agentId: string | null
  channelId: string
  principalKind: 'user' | 'agent'
  userId: string | null
  workspaceId: string
}

function participantInsert(
  workspaceId: string,
  channelId: string,
  participant: ConversationParticipantRef
): GroupParticipantInsert {
  return {
    agentId: participant.kind === 'agent' ? participant.agentId : null,
    channelId,
    principalKind: participant.kind,
    userId: participant.kind === 'user' ? participant.userId : null,
    workspaceId,
  }
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
 * roster commits the channel, every participant row and the creation event in
 * one transaction — any failure rolls all of it back.
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
  // An empty owning workspace reaches the policy as a typed group-scope
  // rejection (group_workspace_missing), still with zero writes.
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
    for (const admission of roster)
      await requireGroupParticipantLiveness(transaction, workspaceId, admission.participant)
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
      .onConflictDoNothing({ target: [channels.workspaceId, channels.idempotencyKey] })
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
      const participantRows = await transaction
        .select({
          agentId: channelParticipants.agentId,
          principalKind: channelParticipants.principalKind,
          userId: channelParticipants.userId,
        })
        .from(channelParticipants)
        .where(
          and(
            eq(channelParticipants.workspaceId, workspaceId),
            eq(channelParticipants.channelId, existing.id)
          )
        )
      const participants = participantRows.map((row): ConversationParticipantRef =>
        row.principalKind === 'user'
          ? { kind: 'user', userId: row.userId! }
          : { agentId: row.agentId!, kind: 'agent' }
      )
      return { channel: summarizeGroupChannel(existing, participants), roster }
    }
    await transaction
      .insert(channelParticipants)
      .values(
        roster.map((admission) => participantInsert(workspaceId, created.id, admission.participant))
      )
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
  /** Previously retained admissions; retained members without one rejoin fail closed at the frontier. */
  priorAdmissions?: readonly GroupAdmission[]
}>

/**
 * Grant-gated roster replacement for one group channel in a single
 * transaction with optimistic concurrency. Every listed participant must
 * present an effective explicit grant — staying in the group without one is
 * rejected with the whole replacement. Newcomers, and retained members whose
 * prior join point is unknown, join fail closed at the channel's current
 * message frontier, so a roster write never over-grants earlier history.
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

  return database.transaction(async (transaction) => {
    await requireGroupMembership(transaction, workspaceId, principal)
    const [channel] = await transaction
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
      .limit(1)
    if (!channel || channel.kind !== 'group' || channel.lifecycleState !== 'active')
      throw new Error('Channel unavailable')
    if (channel.version !== input.expectedVersion) throw new Error('Channel version conflict')
    for (const admission of validation.roster)
      await requireGroupParticipantLiveness(transaction, workspaceId, admission.participant)
    const currentRows = await transaction
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
    const current = new Set(
      currentRows.map((row) =>
        row.principalKind === 'user'
          ? participantKey(workspaceId, { kind: 'user', userId: row.userId! })
          : participantKey(workspaceId, { agentId: row.agentId!, kind: 'agent' })
      )
    )
    const frontier = channel.latestMessageSequence
    const roster = validation.roster.map((admission) => {
      const prior = (input.priorAdmissions ?? []).find((entry) =>
        sameParticipant(entry.participant, admission.participant)
      )
      if (prior && current.has(participantKey(workspaceId, admission.participant)))
        return { ...admission, joinPoint: prior.joinPoint }
      return { ...admission, joinPoint: { joinedAt: input.now, joinedSequence: frontier } }
    })
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
          roster.map((admission) =>
            participantInsert(workspaceId, channelId, admission.participant)
          )
        )
    const [updated] = await transaction
      .update(channels)
      .set({ updatedAt: new Date(), version: channel.version + 1 })
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
          eq(channels.version, input.expectedVersion)
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
  })
}
