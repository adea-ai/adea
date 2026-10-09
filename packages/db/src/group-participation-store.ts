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
  ConversationParticipantRef,
  GroupAdmission,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
  GroupAuthorizationBinding,
  GroupGrantWindow,
  GroupSharingGrant,
} from '@adea-ai/types'
import { and, asc, eq, isNull } from 'drizzle-orm'

import type { AgentHqTransaction } from './connection'
import { evaluateGroupGrantWindow } from './group-participation-policy'
import {
  agents,
  groupAdmissions,
  groupAudienceGrants,
  groupEnlistmentGrants,
  groupSharingGrants,
} from './schema'

/** Loose structural database surface: the full node or an open transaction. */
export type GroupStoreDatabase = {
  select: AgentHqTransaction['select']
}

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
  workspaceId: string,
  row: typeof groupEnlistmentGrants.$inferSelect
): GroupAgentEnlistmentGrant {
  return {
    agent: { agentId: row.agentId, workspaceId },
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
  const [audienceRows, enlistmentRows] = await Promise.all([
    forUpdate ? audienceQuery.for('update') : audienceQuery,
    forUpdate ? enlistmentQuery.for('update') : enlistmentQuery,
  ])
  return {
    audience: audienceRows.map((row) => audienceGrantFromRow(channelId, row)),
    enlistment: enlistmentRows.map((row) => enlistmentGrantFromRow(channelId, workspaceId, row)),
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

/**
 * The group's lead agent for a lead turn: the exactly-one enlisted Agent that
 * is the workspace lead (active, standalone) with an effective enlistment at
 * `now`. Fail-closed null on zero, several, revoked, stale or non-lead
 * enlistments. Read-only; the shared lead-turn writer consumes the id.
 */
export async function resolveGroupLeadAgentId(
  database: GroupStoreDatabase,
  workspaceId: string,
  channelId: string,
  now: string
): Promise<string | null> {
  const roster = await loadGroupRoster(database, workspaceId, channelId)
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
          eq(agents.workspaceId, workspaceId),
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
