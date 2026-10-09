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
  GroupAuthorizationBinding,
  GroupCompletedJob,
  GroupCreationCandidate,
  GroupCreationRejection,
  GroupGrantWindow,
  GroupHistoryEntryRef,
  GroupHistoryReadDecision,
  GroupPublicationDecision,
  GroupSharingGrant,
  GroupSummaryReadDecision,
  GroupTurnDecision,
  MessageSummary,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, asc, eq, isNull, max } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { getMessageForUser, listMessagesForUser } from './conversations'
import {
  decideGroupHistoryRead,
  decideGroupPublication,
  decideGroupSummaryRead,
  decideGroupTurn,
  validateGroupCreation,
} from './group-participation-policy'
import {
  agents,
  channelParticipants,
  channels,
  groupAdmissions,
  groupAudienceGrants,
  groupEnlistmentGrants,
  groupSharingGrants,
  workspaceMemberships,
} from './schema'
import { appendWorkspaceEvent, inTransaction } from './transactions'

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
 * Anything else is answered like a missing channel, so group authority can
 * never leak into workspace tool authority and private direct chats never
 * become group content.
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
 * the held earlier history. Order is preserved on both sides.
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

/**
 * Group-management authority: workspace owner/admin management roles only.
 * Membership alone — even in the same workspace — rewrites no roster and
 * revokes no grant. Denied like a missing channel, fail closed.
 */
export async function requireGroupManagementAuthority(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  const [membership] = await database
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin'))
    throw new Error('Channel unavailable')
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

/** Fail-closed window for an admission whose grant row is gone: behaves as absent. */
const ABSENT_GRANT_WINDOW: GroupGrantWindow = {
  expiresAt: null,
  issuedAt: 'invalid-grant-absent',
  revokedAt: null,
}

function sharingGrantFromRow(
  channelId: string,
  row: typeof groupSharingGrants.$inferSelect
): GroupSharingGrant {
  return {
    expiresAt: row.expiresAt,
    grantId: row.grantId,
    groupId: channelId,
    issuedAt: row.issuedAt,
    participant:
      row.principalKind === 'user'
        ? { kind: 'user', userId: row.userId! }
        : { agentId: row.agentId!, kind: 'agent' },
    revision: row.revision,
    revokedAt: row.revokedAt,
    scope: row.scope as GroupSharingGrant['scope'],
  }
}

function admissionFromRow(
  channelId: string,
  row: typeof groupAdmissions.$inferSelect,
  grantWindow: GroupGrantWindow
): GroupAdmission {
  const authorization: GroupAuthorizationBinding = {
    groupId: row.authGroupId,
    grantId: row.authGrantId,
    revision: row.authRevision,
  }
  return {
    authorization,
    grant: grantWindow,
    joinPoint: { joinedAt: row.joinedAt, joinedSequence: row.joinedSequence },
    participant:
      row.principalKind === 'user'
        ? { kind: 'user', userId: row.userId! }
        : { agentId: row.agentId!, kind: 'agent' },
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

/**
 * Load the canonical roster: admissions joined to their live grant windows.
 * Everything a decision needs — gate aside — comes from these rows in one
 * transaction; caller-supplied join points are never consulted.
 */
export async function loadGroupRoster(
  database: Database,
  workspaceId: string,
  channelId: string
): Promise<readonly GroupAdmission[]> {
  const [admissionRows, audienceRows, enlistmentRows] = await Promise.all([
    database
      .select()
      .from(groupAdmissions)
      .where(
        and(eq(groupAdmissions.workspaceId, workspaceId), eq(groupAdmissions.channelId, channelId))
      )
      .orderBy(asc(groupAdmissions.createdAt), asc(groupAdmissions.id)),
    database
      .select()
      .from(groupAudienceGrants)
      .where(
        and(
          eq(groupAudienceGrants.workspaceId, workspaceId),
          eq(groupAudienceGrants.channelId, channelId)
        )
      ),
    database
      .select()
      .from(groupEnlistmentGrants)
      .where(
        and(
          eq(groupEnlistmentGrants.workspaceId, workspaceId),
          eq(groupEnlistmentGrants.channelId, channelId)
        )
      ),
  ])
  const audienceByGrant = new Map(audienceRows.map((row) => [row.grantId, row]))
  const enlistmentByGrant = new Map(enlistmentRows.map((row) => [row.grantId, row]))
  return admissionRows.map((row) => {
    const audience = row.principalKind === 'user' ? audienceByGrant.get(row.authGrantId) : undefined
    const enlistment =
      row.principalKind === 'agent' ? enlistmentByGrant.get(row.authGrantId) : undefined
    const grantWindow: GroupGrantWindow =
      audience && row.principalKind === 'user'
        ? {
            expiresAt: audience.expiresAt,
            issuedAt: audience.issuedAt,
            revokedAt: audience.revokedAt,
          }
        : enlistment
          ? {
              expiresAt: enlistment.expiresAt,
              issuedAt: enlistment.issuedAt,
              revokedAt: enlistment.revokedAt,
            }
          : ABSENT_GRANT_WINDOW
    return admissionFromRow(channelId, row, grantWindow)
  })
}

/** Load live sharing grants for one group in the deciding transaction. */
export async function loadGroupSharingGrants(
  database: Database,
  workspaceId: string,
  channelId: string
): Promise<readonly GroupSharingGrant[]> {
  const rows = await database
    .select()
    .from(groupSharingGrants)
    .where(
      and(
        eq(groupSharingGrants.workspaceId, workspaceId),
        eq(groupSharingGrants.channelId, channelId)
      )
    )
  return rows.map((row) => sharingGrantFromRow(channelId, row))
}

async function loadChannelGate(
  database: Database,
  workspaceId: string,
  channelId: string
): Promise<GroupChannelGate> {
  const [channel] = await database
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
    .limit(1)
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

/**
 * Join-point-filtered message history for one group channel. The page is
 * fetched through the existing access-checked read, then every entry is
 * decided inside one transaction against canonical admissions and live
 * grants; races fail closed because the decision always runs after the
 * fetch. Pagination cursors describe the underlying page; hidden earlier
 * entries can shorten a page, so clients keep paging with
 * `nextAfterSequence` until it is absent.
 */
export async function listGroupChannelMessagesForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ afterSequence?: number; limit?: number; threadRootMessageId?: string }>,
  now: string
) {
  const page = await listMessagesForUser(database, workspaceId, channelId, principal, options)
  const participant: ConversationParticipantRef = { kind: 'user', userId: principal.userId }
  const { visible } = await inTransaction(database, async (transaction) => {
    const gate = await loadChannelGate(transaction, workspaceId, channelId)
    const roster = await loadGroupRoster(transaction, workspaceId, channelId)
    const sharingGrants = await loadGroupSharingGrants(transaction, workspaceId, channelId)
    return partitionGroupChannelHistory(gate, {
      admission: admissionForParticipant(roster, participant),
      entries: page.messages.map((message) => ({
        occurredAt: message.createdAt,
        sequence: message.sequence,
      })),
      now,
      sharingGrants,
    })
  })
  const allowed = new Set(visible.map((entry) => entry.sequence))
  return Object.freeze({
    ...page,
    messages: Object.freeze(page.messages.filter((message) => allowed.has(message.sequence))),
  })
}

/**
 * One group message gated by its join point. Denied entries answer exactly
 * like missing ones, so the gate is not a history oracle.
 */
export async function getGroupMessageForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  messageId: string,
  principal: UserPrincipalRef,
  now: string
): Promise<MessageSummary> {
  const message = await getMessageForUser(database, workspaceId, messageId, principal)
  if (message.channelId !== channelId) throw new Error('Message unavailable')
  const participant: ConversationParticipantRef = { kind: 'user', userId: principal.userId }
  const decision = await inTransaction(database, async (transaction) => {
    const gate = await loadChannelGate(transaction, workspaceId, channelId)
    const roster = await loadGroupRoster(transaction, workspaceId, channelId)
    const sharingGrants = await loadGroupSharingGrants(transaction, workspaceId, channelId)
    return authorizeGroupChannelHistoryRead(gate, {
      admission: admissionForParticipant(roster, participant),
      entry: { occurredAt: message.createdAt, sequence: message.sequence },
      now,
      sharingGrants,
    })
  })
  if (decision.action !== 'allow') throw new Error('Message unavailable')
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
    for (const admission of roster)
      await requireGroupParticipantLiveness(transaction, workspaceId, admission.participant)
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

  return database.transaction(async (transaction) => {
    await requireGroupManagementAuthority(transaction, workspaceId, principal)
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
    const stored = await loadGroupRoster(transaction, workspaceId, channelId)
    const storedByParticipant = new Map(
      stored.map((admission) => [participantKey(workspaceId, admission.participant), admission])
    )
    const frontier = channel.latestMessageSequence
    const roster = validation.roster.map((admission) => {
      const canonical = storedByParticipant.get(participantKey(workspaceId, admission.participant))
      if (canonical) return { ...admission, joinPoint: canonical.joinPoint }
      // Strictly after the observed frontier: the decision allows sequences
      // at or after the join point, so joining AT the frontier would leak the
      // boundary message posted before admission.
      return { ...admission, joinPoint: { joinedAt: input.now, joinedSequence: frontier + 1 } }
    })
    for (const candidate of input.candidates) {
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
          roster.map((admission) =>
            participantInsert(workspaceId, channelId, admission.participant)
          )
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
