/*
 * Durable group participation store (M15 #1178).
 *
 * Canonical row mapping and loading for group grants and admissions. This
 * module depends only on the schema and the participation types — never on
 * `conversations` — so both the conversation reads and the group channel
 * orchestration share one loading path with no import cycle.
 *
 * Binding rule: an admission's live window resolves from its grant row only
 * when the row matches the admission's retained binding on every field —
 * same grant id, same revision, same subject (user or Agent). Anything else
 * (missing row, stale revision, retargeted subject) resolves to the
 * fail-closed absent window, which reads as expired and behaves as absent on
 * every decision path. A regrant therefore never revives an admission bound
 * to a revoked revision, and a retargeted grant id never authorizes the
 * wrong participant, until the roster is explicitly rewritten with the new
 * binding.
 */
import type {
  ChannelSummary,
  ConversationParticipantRef,
  UserPrincipalRef,
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
} from '@adea-ai/types'
import { authorizeWorkspaceAction } from '@adea-ai/auth/authorization'
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'

import type { AgentHqTransaction } from './connection'
import {
  decideGroupHistoryRead,
  decideGroupPublication,
  decideGroupSummaryRead,
  decideGroupTurn,
  evaluateGroupGrantWindow,
} from './group-participation-policy'
import {
  agents,
  channelParticipants,
  groupAdmissions,
  groupAudienceGrants,
  groupEnlistmentGrants,
  groupSharingGrants,
  messages,
  workspaceMemberships,
  workspaces,
} from './schema'

/** Loose structural database surface: the full node or an open transaction. */
export type GroupStoreDatabase = {
  select: AgentHqTransaction['select']
}

/** Effective history window for one admitted user in one group channel. */
export type GroupHistoryAccess = Readonly<{
  joinedSequence: number
  includesEarlierHistory: boolean
  includesEarlierSummary: boolean
}>

/** Fail-closed window for an unprovable grant: behaves as absent everywhere. */
export const ABSENT_GRANT_WINDOW: GroupGrantWindow = {
  expiresAt: null,
  issuedAt: 'invalid-grant-absent',
  revokedAt: null,
}

export function sharingGrantFromRow(
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

export function admissionFromRow(
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

function sameParticipant(
  left: ConversationParticipantRef,
  right: ConversationParticipantRef
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'user' && right.kind === 'user') return left.userId === right.userId
  if (left.kind === 'agent' && right.kind === 'agent') return left.agentId === right.agentId
  return false
}

/** The validated roster's standing for one participant, or null when never admitted. */
export function admissionForParticipant(
  roster: readonly GroupAdmission[],
  participant: ConversationParticipantRef
): GroupAdmission | null {
  return roster.find((admission) => sameParticipant(admission.participant, participant)) ?? null
}

/**
 * Pure binding check: the live window for one admission resolves from its
 * grant row only on a full identity/revision match — the retained binding
 * must name THIS group, the same grant id and revision, and the same
 * subject (user or Agent). Anything else resolves fail-closed. Unit-tested
 * directly; the policy's own grant-identity check denies cross-group
 * bindings a second time at decision time.
 */
export function resolveAdmissionWindow(
  admission: Pick<GroupAdmission, 'authorization' | 'participant'>,
  grants: Readonly<{
    audience: readonly GroupAudienceGrant[]
    enlistment: readonly GroupAgentEnlistmentGrant[]
  }>,
  groupId: string
): GroupGrantWindow {
  const { authorization, participant } = admission
  if (authorization.groupId !== groupId) return ABSENT_GRANT_WINDOW
  if (participant.kind === 'user') {
    const grant = grants.audience.find((candidate) => candidate.grantId === authorization.grantId)
    if (
      grant &&
      grant.revision === authorization.revision &&
      grant.participant.userId === participant.userId
    )
      return { expiresAt: grant.expiresAt, issuedAt: grant.issuedAt, revokedAt: grant.revokedAt }
    return ABSENT_GRANT_WINDOW
  }
  const grant = grants.enlistment.find((candidate) => candidate.grantId === authorization.grantId)
  if (
    grant &&
    grant.revision === authorization.revision &&
    grant.agent.agentId === participant.agentId
  )
    return { expiresAt: grant.expiresAt, issuedAt: grant.issuedAt, revokedAt: grant.revokedAt }
  return ABSENT_GRANT_WINDOW
}

/** Row-mapping helpers shared by the roster loader. */
export function audienceGrantFromRow(
  channelId: string,
  row: typeof groupAudienceGrants.$inferSelect
): GroupAudienceGrant {
  return {
    expiresAt: row.expiresAt,
    grantId: row.grantId,
    groupId: channelId,
    issuedAt: row.issuedAt,
    participant: { kind: 'user', userId: row.userId },
    revision: row.revision,
    revokedAt: row.revokedAt,
  }
}

export function enlistmentGrantFromRow(
  channelId: string,
  row: typeof groupEnlistmentGrants.$inferSelect,
  agentWorkspaceId: string
): GroupAgentEnlistmentGrant {
  return {
    // The Agent's true source workspace, resolved from the registry — never
    // the host workspace. The transactional layer proves at enlist time that
    // this matches the grant's claimed source, so the label cannot drift.
    agent: { agentId: row.agentId, workspaceId: agentWorkspaceId },
    expiresAt: row.expiresAt,
    grantId: row.grantId,
    groupId: channelId,
    issuedAt: row.issuedAt,
    revision: row.revision,
    revokedAt: row.revokedAt,
  }
}

async function selectGrants(
  database: GroupStoreDatabase,
  workspaceId: string,
  channelId: string,
  forUpdate: boolean
) {
  const audienceQuery = database
    .select()
    .from(groupAudienceGrants)
    .where(
      and(
        eq(groupAudienceGrants.workspaceId, workspaceId),
        eq(groupAudienceGrants.channelId, channelId)
      )
    )
  const enlistmentQuery = database
    .select()
    .from(groupEnlistmentGrants)
    .where(
      and(
        eq(groupEnlistmentGrants.workspaceId, workspaceId),
        eq(groupEnlistmentGrants.channelId, channelId)
      )
    )
  const [audienceRows, enlistmentRows, agentHomes] = await Promise.all([
    forUpdate ? audienceQuery.for('update') : audienceQuery,
    forUpdate ? enlistmentQuery.for('update') : enlistmentQuery,
    database.select({ agentId: agents.id, workspaceId: agents.workspaceId }).from(agents),
  ])
  const homeWorkspaceByAgent = new Map(agentHomes.map((row) => [row.agentId, row.workspaceId]))
  return {
    audience: audienceRows.map((row) => audienceGrantFromRow(channelId, row)),
    enlistment: enlistmentRows.map((row) =>
      enlistmentGrantFromRow(
        channelId,
        row,
        // Fail-closed: an enlistment whose Agent row is gone proves no home
        // workspace, and every consumer treats the grant as absent.
        homeWorkspaceByAgent.get(row.agentId) ?? ''
      )
    ),
  }
}

/**
 * Canonical roster: admissions joined to live grant windows under the full
 * binding rule. Pass `forUpdate` inside a write fence so the admission and
 * grant rows are locked with the decision — a concurrent revocation then
 * orders before or after the fence, never inside it.
 */
export async function loadGroupRoster(
  database: GroupStoreDatabase,
  workspaceId: string,
  channelId: string,
  options: Readonly<{ forUpdate?: boolean }> = {}
): Promise<readonly GroupAdmission[]> {
  const admissionQuery = database
    .select()
    .from(groupAdmissions)
    .where(
      and(eq(groupAdmissions.workspaceId, workspaceId), eq(groupAdmissions.channelId, channelId))
    )
    .orderBy(asc(groupAdmissions.createdAt), asc(groupAdmissions.id))
  const [admissionRows, grants] = await Promise.all([
    options.forUpdate ? admissionQuery.for('update') : admissionQuery,
    selectGrants(database, workspaceId, channelId, options.forUpdate ?? false),
  ])
  return admissionRows.map((row) =>
    admissionFromRow(
      channelId,
      row,
      resolveAdmissionWindow(
        {
          authorization: {
            groupId: row.authGroupId,
            grantId: row.authGrantId,
            revision: row.authRevision,
          },
          participant:
            row.principalKind === 'user'
              ? { kind: 'user', userId: row.userId! }
              : { agentId: row.agentId!, kind: 'agent' },
        },
        grants,
        channelId
      )
    )
  )
}

/** Live sharing grants for one group; optionally locked for a write fence. */
export async function loadGroupSharingGrants(
  database: GroupStoreDatabase,
  workspaceId: string,
  channelId: string,
  options: Readonly<{ forUpdate?: boolean }> = {}
): Promise<readonly GroupSharingGrant[]> {
  const query = database
    .select()
    .from(groupSharingGrants)
    .where(
      and(
        eq(groupSharingGrants.workspaceId, workspaceId),
        eq(groupSharingGrants.channelId, channelId)
      )
    )
  const rows = options.forUpdate ? await query.for('update') : await query
  return rows.map((row) => sharingGrantFromRow(channelId, row))
}

/** One participant's canonical admission, or null when never admitted. */
export async function loadGroupAdmission(
  database: GroupStoreDatabase,
  workspaceId: string,
  channelId: string,
  participant: ConversationParticipantRef,
  options: Readonly<{ forUpdate?: boolean }> = {}
): Promise<GroupAdmission | null> {
  const roster = await loadGroupRoster(database, workspaceId, channelId, options)
  return roster.find((admission) => sameParticipant(admission.participant, participant)) ?? null
}

/** Whether a retained admission still has effective canonical grant standing. */
export function admissionInForce(
  admission: GroupAdmission | null,
  groupId: string,
  now: string
): boolean {
  return admission !== null && decideGroupTurn({ admission, groupId, now }).action === 'allow'
}

/** Group ids whose retained user admission resolves to a live, matching grant. */
export async function groupChannelIdsInForce(
  database: GroupStoreDatabase,
  userId: string,
  now: string,
  workspaceId?: string
): Promise<Set<string>> {
  const rows = await database
    .select({ admission: groupAdmissions, grant: groupAudienceGrants })
    .from(groupAdmissions)
    .leftJoin(
      groupAudienceGrants,
      and(
        eq(groupAudienceGrants.workspaceId, groupAdmissions.workspaceId),
        eq(groupAudienceGrants.channelId, groupAdmissions.channelId),
        eq(groupAudienceGrants.grantId, groupAdmissions.authGrantId)
      )
    )
    .where(
      and(
        eq(groupAdmissions.principalKind, 'user'),
        eq(groupAdmissions.userId, userId),
        ...(workspaceId ? [eq(groupAdmissions.workspaceId, workspaceId)] : [])
      )
    )
  const inForce = rows.filter(({ admission: row, grant }) => {
    const channelId = row.channelId
    const window = resolveAdmissionWindow(
      {
        authorization: {
          groupId: row.authGroupId,
          grantId: row.authGrantId,
          revision: row.authRevision,
        },
        participant: { kind: 'user', userId },
      },
      {
        audience: grant ? [audienceGrantFromRow(channelId, grant)] : [],
        enlistment: [],
      },
      channelId
    )
    return admissionInForce(admissionFromRow(channelId, row, window), channelId, now)
  })
  return new Set(inForce.map(({ admission }) => admission.channelId))
}

/**
 * Resolve the same join-point history policy used by message reads for every
 * effective group admission held by a user. Product queries use this compact
 * map to filter messages in SQL before pagination and aggregation.
 */
export async function groupHistoryAccessByUser(
  database: GroupStoreDatabase,
  userId: string,
  now: string,
  workspaceId?: string
): Promise<ReadonlyMap<string, GroupHistoryAccess>> {
  const rows = await database
    .select({ admission: groupAdmissions, grant: groupAudienceGrants })
    .from(groupAdmissions)
    .leftJoin(
      groupAudienceGrants,
      and(
        eq(groupAudienceGrants.workspaceId, groupAdmissions.workspaceId),
        eq(groupAudienceGrants.channelId, groupAdmissions.channelId),
        eq(groupAudienceGrants.grantId, groupAdmissions.authGrantId)
      )
    )
    .where(
      and(
        eq(groupAdmissions.principalKind, 'user'),
        eq(groupAdmissions.userId, userId),
        ...(workspaceId ? [eq(groupAdmissions.workspaceId, workspaceId)] : [])
      )
    )

  const effective: Array<{ channelId: string; admission: GroupAdmission }> = []
  for (const { admission: row, grant } of rows) {
    const channelId = row.channelId
    const window = resolveAdmissionWindow(
      {
        authorization: {
          groupId: row.authGroupId,
          grantId: row.authGrantId,
          revision: row.authRevision,
        },
        participant: { kind: 'user', userId },
      },
      { audience: grant ? [audienceGrantFromRow(channelId, grant)] : [], enlistment: [] },
      channelId
    )
    const admission = admissionFromRow(channelId, row, window)
    if (admissionInForce(admission, channelId, now)) effective.push({ channelId, admission })
  }
  if (!effective.length) return new Map()

  const channelIds = [...new Set(effective.map(({ channelId }) => channelId))]
  const sharingRows = await database
    .select()
    .from(groupSharingGrants)
    .where(
      and(
        eq(groupSharingGrants.principalKind, 'user'),
        eq(groupSharingGrants.userId, userId),
        inArray(groupSharingGrants.channelId, channelIds)
      )
    )
  const sharingByChannel = new Map<string, GroupSharingGrant[]>()
  for (const row of sharingRows) {
    const grants = sharingByChannel.get(row.channelId) ?? []
    grants.push(sharingGrantFromRow(row.channelId, row))
    sharingByChannel.set(row.channelId, grants)
  }

  const access = new Map<string, GroupHistoryAccess>()
  for (const { channelId, admission } of effective) {
    const joinedSequence = admission.joinPoint.joinedSequence
    const includesEarlierHistory =
      joinedSequence > 0 &&
      decideGroupHistoryRead({
        admission,
        entry: { occurredAt: now, sequence: joinedSequence - 1 },
        groupId: channelId,
        now,
        sharingGrants: sharingByChannel.get(channelId) ?? [],
      }).action === 'allow'
    const includesEarlierSummary =
      joinedSequence > 0 &&
      decideGroupSummaryRead({
        admission,
        fromSequence: joinedSequence - 1,
        groupId: channelId,
        now,
        sharingGrants: sharingByChannel.get(channelId) ?? [],
      }).action === 'allow'
    const previous = access.get(channelId)
    access.set(channelId, {
      joinedSequence: previous ? Math.min(previous.joinedSequence, joinedSequence) : joinedSequence,
      includesEarlierHistory: Boolean(previous?.includesEarlierHistory || includesEarlierHistory),
      includesEarlierSummary: Boolean(previous?.includesEarlierSummary || includesEarlierSummary),
    })
  }
  return access
}

function groupMessageVisibleCondition(
  input: {
    channelId: SQL
    sequence: SQL
    access: ReadonlyMap<string, GroupHistoryAccess>
  },
  includesEarlier: (history: GroupHistoryAccess) => boolean
): SQL {
  const conditions = [...input.access].map(([channelId, history]) =>
    includesEarlier(history)
      ? sql`${input.channelId} = ${channelId}::uuid`
      : sql`(${input.channelId} = ${channelId}::uuid and ${input.sequence} >= ${history.joinedSequence})`
  )
  return conditions.length ? (or(...conditions) ?? sql`false`) : sql`false`
}

/** SQL predicate for messages a user may see under effective group history. */
export function groupHistoryMessageVisibleCondition(input: {
  channelId: SQL
  sequence: SQL
  access: ReadonlyMap<string, GroupHistoryAccess>
}): SQL {
  return groupMessageVisibleCondition(input, (history) => history.includesEarlierHistory)
}

/** Aggregate summaries need their own grant; earlier-history access is not enough. */
export function groupSummaryMessageVisibleCondition(input: {
  channelId: SQL
  sequence: SQL
  access: ReadonlyMap<string, GroupHistoryAccess>
}): SQL {
  return groupMessageVisibleCondition(input, (history) => history.includesEarlierSummary)
}

function groupMessageAndThreadVisibleCondition(
  input: {
    channelId: SQL
    sequence: SQL
    threadRootMessageId: SQL
    replyToMessageId?: SQL
    access: ReadonlyMap<string, GroupHistoryAccess>
  },
  messageVisibility: (input: {
    channelId: SQL
    sequence: SQL
    access: ReadonlyMap<string, GroupHistoryAccess>
  }) => SQL
): SQL {
  const visibleRoot = messageVisibility({
    channelId: sql.raw('history_root.channel_id'),
    sequence: sql.raw('history_root.sequence'),
    access: input.access,
  })
  const visibleReply = input.replyToMessageId
    ? sql`(
        ${input.replyToMessageId} is null
        or exists (
          select 1 from ${messages} as history_reply_parent
          where history_reply_parent.id = ${input.replyToMessageId}
            and history_reply_parent.channel_id = ${input.channelId}
            and ${messageVisibility({
              channelId: sql.raw('history_reply_parent.channel_id'),
              sequence: sql.raw('history_reply_parent.sequence'),
              access: input.access,
            })}
        )
      )`
    : sql`true`
  return sql`(
    ${messageVisibility({
      channelId: input.channelId,
      sequence: input.sequence,
      access: input.access,
    })}
    and (
      ${input.threadRootMessageId} is null
      or exists (
        select 1 from ${messages} as history_root
        where history_root.id = ${input.threadRootMessageId}
          and history_root.channel_id = ${input.channelId}
          and ${visibleRoot}
      )
    )
    and ${visibleReply}
  )`
}

/** A visible reply cannot reveal a thread root the reader cannot see. */
export function groupHistoryMessageAndThreadVisibleCondition(input: {
  channelId: SQL
  sequence: SQL
  threadRootMessageId: SQL
  replyToMessageId?: SQL
  access: ReadonlyMap<string, GroupHistoryAccess>
}): SQL {
  return groupMessageAndThreadVisibleCondition(input, groupHistoryMessageVisibleCondition)
}

export function groupSummaryMessageAndThreadVisibleCondition(input: {
  channelId: SQL
  sequence: SQL
  threadRootMessageId: SQL
  replyToMessageId?: SQL
  access: ReadonlyMap<string, GroupHistoryAccess>
}): SQL {
  return groupMessageAndThreadVisibleCondition(input, groupSummaryMessageVisibleCondition)
}

/** SQL predicate shared by product queries that expose channels to a user. */
export function userChannelVisibility(input: {
  channelId: SQL
  inForceGroupIds: readonly string[]
  kind: SQL
  userId: string
  visibility: SQL
}): SQL {
  const groupInForce = input.inForceGroupIds.length
    ? sql`${input.channelId} in (${sql.join(
        input.inForceGroupIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})`
    : sql`false`
  return sql`(case when ${input.kind} = 'group' then ${groupInForce} else (
    ${input.visibility} = 'workspace'
    or exists (
      select 1 from ${channelParticipants} as roster_row
      where roster_row.channel_id = ${input.channelId}
        and roster_row.principal_kind = 'user'
        and roster_row.user_id = ${input.userId}
    )
  ) end)`
}

/**
 * The group's lead agent for a lead turn: the exactly-one enlisted Agent that
 * is a workspace lead (active, standalone) with an effective enlistment at
 * `now` — resolved in the Agent's own source workspace, never the host's.
 * Tool authority stays source-scoped: the host workspace confers no
 * capabilities over foreign Agents. Fail-closed null on zero, several,
 * revoked, stale or non-lead enlistments. Read-only; the shared lead-turn
 * writer consumes the id.
 */
export async function resolveGroupLeadAgentId(
  database: GroupStoreDatabase,
  workspaceId: string,
  channelId: string,
  now: string,
  options: Readonly<{ forUpdate?: boolean }> = {}
): Promise<string | null> {
  const roster = await loadGroupRoster(database, workspaceId, channelId, options)
  const eligible: string[] = []
  for (const admission of roster) {
    if (admission.participant.kind !== 'agent') continue
    if (evaluateGroupGrantWindow(admission.grant, now) !== 'effective') continue
    const [agent] = await database
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, admission.participant.agentId),
          eq(agents.isWorkspaceLead, true),
          eq(agents.lifecycleState, 'active'),
          isNull(agents.projectId)
        )
      )
      .limit(1)
    if (agent) eligible.push(agent.id)
  }
  return eligible.length === 1 ? eligible[0]! : null
}

/* Channel-pinned pure decisions (no I/O): safe for unit scope. */

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

export function canonicalKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalKey(entry)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export function participantKey(
  workspaceId: string,
  participant: ConversationParticipantRef
): string {
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

/**
 * Resolve the group's lead agent for a lead turn: the exactly-one enlisted
 * Agent that is the workspace lead (active, standalone). Returns its agent
 * id, or null when there is no single eligible lead. Reads only — the
 * actual lead-turn authorization and persistence stay in the shared
 * lead-turn writer (owned with #1177; this helper supplies the validated
 * group authority that writer will consume once its hunk lands).
 *
 * Fail-closed on ambiguity: zero or several eligible leads resolve to null
 * rather than guessing. A revoked or stale enlistment never resolves
 * (binding-checked live windows only).
 */
export async function resolveGroupLeadAgent(
  database: GroupStoreDatabase,
  workspaceId: string,
  channelId: string,
  now: string
): Promise<string | null> {
  return resolveGroupLeadAgentId(database, workspaceId, channelId, now)
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

export async function requireGroupMembership(
  database: GroupStoreDatabase,
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
  database: GroupStoreDatabase,
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

export async function requireGroupParticipantLiveness(
  database: GroupStoreDatabase,
  workspaceId: string,
  participant: ConversationParticipantRef
) {
  // Humans participate through host membership — their only authority
  // anchor. Agents never pass through here: their standing is proven
  // against their own source workspace by requireAgentEnlistmentSource.
  if (participant.kind === 'agent') throw new Error('Agent unavailable')
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
}

/**
 * Source-workspace standing for an enlisted Agent (M15.01 scope
 * reconciliation, adea-ai/adea#1178). The host workspace never confers
 * authority over foreign Agents, so liveness is proven where the Agent
 * actually lives. Source authorization is rechecked under a transaction lock
 * before any grant write; unauthorized or unknown Agents are returned as
 * unavailable, while an authorized caller receives a typed rejection for an
 * inactive Agent or mismatched source claim.
 */
export async function requireAgentEnlistmentSource(
  database: AgentHqTransaction,
  candidateIndex: number,
  agentId: string,
  claimedWorkspaceId: string,
  principal: UserPrincipalRef,
  barrier: Readonly<{
    afterSourceAuthorityLocks?: () => Promise<void>
    afterAgentLock?: () => Promise<void>
  }> = {}
) {
  const participant = { agentId, kind: 'agent' } as const
  const reject = (reason: 'agent_inactive' | 'grant_workspace_mismatch') => {
    throw new GroupCreationError([{ candidateIndex, participant, reason, scope: 'candidate' }])
  }
  const [agent] = await database
    .select({ lifecycleState: agents.lifecycleState, workspaceId: agents.workspaceId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
  // An unknown Agent and a real Agent whose source workspace is unavailable
  // must be indistinguishable to the host caller.
  if (!agent) throw new Error('Agent unavailable')

  // Resolve authority only from the canonical Agent row, then hold both the
  // membership and workspace rows through the grant write. A concurrent
  // membership removal, role change, or workspace deletion therefore orders
  // before or after this transaction instead of racing an earlier route check.
  const [membership] = await database
    .select({ role: workspaceMemberships.role, deletionPending: workspaces.deletionRequestedAt })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, agent.workspaceId),
        eq(workspaceMemberships.userId, principal.userId),
        isNull(workspaces.deletedAt)
      )
    )
    .for('share')
  const authorization = await authorizeWorkspaceAction(
    { permission: 'workspace.update', principal, workspaceId: agent.workspaceId },
    {
      findMembership: async () =>
        membership
          ? {
              role: membership.role,
              deletionPending: membership.deletionPending !== null,
            }
          : null,
    }
  )
  if (!authorization.allowed) throw new Error('Agent unavailable')
  await barrier.afterSourceAuthorityLocks?.()

  // Archive checks source membership and workspace with compatible SHARE
  // locks, then updates the Agent row. The Agent row is the serialization
  // point: lock it after the source authority rows and recheck its canonical
  // workspace and lifecycle through the grant write.
  const [lockedAgent] = await database
    .select({ lifecycleState: agents.lifecycleState, workspaceId: agents.workspaceId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
    .for('share')
  if (!lockedAgent || lockedAgent.workspaceId !== agent.workspaceId)
    throw new Error('Agent unavailable')
  if (lockedAgent.lifecycleState !== 'active') return reject('agent_inactive')
  if (lockedAgent.workspaceId !== claimedWorkspaceId) return reject('grant_workspace_mismatch')
  await barrier.afterAgentLock?.()
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
