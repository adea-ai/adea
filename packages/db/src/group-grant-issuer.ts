/*
 * Server-side group grant issuance (M15 #1178).
 *
 * A caller selects who belongs in a group by qualified identity only: human
 * user ids and Agent `{agentId, workspaceId}` pairs. This module is the one
 * place that turns a selection into the explicit audience and enlistment
 * grants the group policy consumes. Grant ids, revisions and windows are
 * chosen here, never read from a request, and a grant is only ever bound to
 * the group it is issued for.
 *
 * Issuing a grant confers no authority by itself. Standing is still proven
 * inside the writing transaction by the unchanged store checks: a human must
 * hold a live host-workspace membership, an Agent must be active and its
 * source workspace must authorize the acting principal, and roster management
 * still needs owner/admin authority. A selection that fails any of them is
 * rejected with the policy's typed reasons and writes nothing.
 *
 * A save never disturbs people who are already in, and never readmits anyone
 * by accident:
 * - first issuance uses a deterministic grant id at revision 1, so a retried
 *   creation hashes to the same payload and replays to the same group;
 * - a member who is on the roster the caller saw keeps the exact grant their
 *   admission is bound to (id and revision), so the binding of any job bound to
 *   it is untouched. If that grant has been revoked or has expired it is passed
 *   through unchanged and the policy refuses the save with its typed reason:
 *   keeping someone whose access was withdrawn is never a silent renewal. The
 *   owner removes them, and adds them again if they should come back;
 * - a person who is not on the roster is being (re)admitted, which is the one
 *   explicit act that issues a grant. It is always a new, higher revision of
 *   the same grant, so nothing bound to an earlier admission (a job that
 *   finished while they were removed) can match the new one, and the store
 *   gives the new admission a fresh history frontier.
 *
 * The roster is read at the version the caller saw: the channel row is locked
 * and the version checked before anything is issued. A grant revoked since
 * the caller drafted is seen as it now is, so keeping that member is refused
 * with its typed reason and a stale draft can never regrant anyone.
 */
import { randomUUID } from 'node:crypto'

import type {
  ChannelSummary,
  GroupAdmission,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
  GroupCreationCandidate,
  QualifiedAgentIdentity,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  createGroupChannelWithGrants,
  setGroupChannelParticipantsInTransaction,
  type GroupChannelCreateInput,
} from './group-channels'
import { validateGroupCreation } from './group-participation-policy'
import {
  GroupCreationError,
  groupCreationCandidatesFromGrants,
  loadGroupRoster,
  requireGroupManagementAuthority,
} from './group-participation-store'
import { agents, channels, groupAudienceGrants, groupEnlistmentGrants } from './schema'

/**
 * Who a group should contain, by stable identity. `humans` are user ids;
 * `agents` are workspace-qualified, so two Agents that share a display name
 * are different entries and nothing is ever resolved by name.
 */
export type GroupSelection = Readonly<{
  agents: readonly QualifiedAgentIdentity[]
  humans: readonly string[]
}>

type Database = AgentHqDatabase | AgentHqTransaction

/** The grants a selection will carry, before standing is proven. */
export type IssuedGroupGrants = Readonly<{
  audienceGrants: readonly GroupAudienceGrant[]
  enlistmentGrants: readonly GroupAgentEnlistmentGrant[]
}>

/** What is already stored for the group, used to keep members' grants stable. */
export type StoredGroupGrants = Readonly<{
  audienceGrants: readonly GroupAudienceGrant[]
  enlistmentGrants: readonly GroupAgentEnlistmentGrant[]
}>

export const NO_STORED_GROUP_GRANTS: StoredGroupGrants = {
  audienceGrants: [],
  enlistmentGrants: [],
}

/** Deterministic id of the grant that first admits a human to any group. */
export function audienceGrantIdFor(userId: string): string {
  return `audience:${userId}`
}

/** Deterministic id of the grant that first enlists a qualified Agent. */
export function enlistmentGrantIdFor(agent: QualifiedAgentIdentity): string {
  return `enlistment:${agent.workspaceId}:${agent.agentId}`
}

function highestRevision<T extends GroupAudienceGrant | GroupAgentEnlistmentGrant>(
  grants: readonly T[],
  preferredGrantId?: string
): T | undefined {
  const preferred = preferredGrantId
    ? grants.filter((grant) => grant.grantId === preferredGrantId)
    : []
  return (preferred.length > 0 ? preferred : grants).toSorted(
    (left, right) => right.revision - left.revision
  )[0]
}

/**
 * Issue the grants a selection needs for one group. Pure: reads only the
 * stored grants and the roster it is handed, so the same inputs always issue
 * the same grants. `roster` is the group's current admissions; with none, every
 * identity is a first issuance.
 */
export function issueGroupGrants(
  input: Readonly<{
    groupId: string
    now: string
    roster?: readonly GroupAdmission[]
    selection: GroupSelection
    stored?: StoredGroupGrants
  }>
): IssuedGroupGrants {
  const stored = input.stored ?? NO_STORED_GROUP_GRANTS
  const roster = input.roster ?? []
  const humanAdmission = (userId: string) =>
    roster.find(({ participant }) => participant.kind === 'user' && participant.userId === userId)
  const agentAdmission = (agentId: string) =>
    roster.find(
      ({ participant }) => participant.kind === 'agent' && participant.agentId === agentId
    )
  const audienceGrants = input.selection.humans.map((userId): GroupAudienceGrant => {
    const forUser = stored.audienceGrants.filter((grant) => grant.participant.userId === userId)
    const admission = humanAdmission(userId)
    if (admission) {
      const held = highestRevision(forUser, admission.authorization.grantId)
      if (held) return held
    }
    const grantId = audienceGrantIdFor(userId)
    const previous = highestRevision(forUser.filter((grant) => grant.grantId === grantId))
    return {
      expiresAt: null,
      grantId,
      groupId: input.groupId,
      issuedAt: input.now,
      participant: { kind: 'user', userId },
      revision: (previous?.revision ?? 0) + 1,
      revokedAt: null,
    }
  })
  const enlistmentGrants = input.selection.agents.map((agent): GroupAgentEnlistmentGrant => {
    const forAgent = stored.enlistmentGrants.filter(
      (grant) => grant.agent.agentId === agent.agentId
    )
    const admission = agentAdmission(agent.agentId)
    if (admission) {
      const held = highestRevision(forAgent, admission.authorization.grantId)
      if (held)
        return { ...held, agent: { agentId: agent.agentId, workspaceId: agent.workspaceId } }
    }
    const grantId = enlistmentGrantIdFor(agent)
    const previous = highestRevision(forAgent.filter((grant) => grant.grantId === grantId))
    return {
      agent: { agentId: agent.agentId, workspaceId: agent.workspaceId },
      expiresAt: null,
      grantId,
      groupId: input.groupId,
      issuedAt: input.now,
      revision: (previous?.revision ?? 0) + 1,
      revokedAt: null,
    }
  })
  return { audienceGrants, enlistmentGrants }
}

/** The acting creator is always the founding member; a selection never has to name them. */
function withoutCreator(selection: GroupSelection, creator: UserPrincipalRef): GroupSelection {
  return {
    agents: selection.agents,
    humans: selection.humans.filter((id) => id !== creator.userId),
  }
}

export type GroupCreateFromSelectionInput = Readonly<
  Omit<GroupChannelCreateInput, 'candidates'> & { selection: GroupSelection }
>

/**
 * Atomically create a group from a selection. The creator is founded
 * explicitly, every other member's grant is issued here, and the existing
 * atomic creation path validates and writes them. The roster is exactly what
 * the server committed; the caller supplies no grant of any kind.
 */
export async function createGroupChannelFromSelection(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: GroupCreateFromSelectionInput
) {
  const channelId = input.channelId ?? randomUUID()
  const issued = issueGroupGrants({
    groupId: channelId,
    now: input.now,
    selection: withoutCreator(input.selection, principal),
  })
  const founder: GroupAudienceGrant = {
    expiresAt: null,
    grantId: `founder-${principal.userId}`,
    groupId: channelId,
    issuedAt: input.now,
    participant: principal,
    revision: 1,
    revokedAt: null,
  }
  return createGroupChannelWithGrants(database, workspaceId, principal, {
    candidates: groupCreationCandidatesFromGrants(workspaceId, {
      audienceGrants: [founder, ...issued.audienceGrants],
      enlistmentGrants: issued.enlistmentGrants,
    }),
    channelId,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
    title: input.title,
  })
}

async function loadStoredGroupGrants(
  transaction: Database,
  workspaceId: string,
  channelId: string
): Promise<StoredGroupGrants> {
  const [audienceRows, enlistmentRows] = await Promise.all([
    transaction
      .select()
      .from(groupAudienceGrants)
      .where(
        and(
          eq(groupAudienceGrants.workspaceId, workspaceId),
          eq(groupAudienceGrants.channelId, channelId)
        )
      ),
    transaction
      .select({
        grant: groupEnlistmentGrants,
        agentWorkspaceId: agents.workspaceId,
      })
      .from(groupEnlistmentGrants)
      .innerJoin(agents, eq(agents.id, groupEnlistmentGrants.agentId))
      .where(
        and(
          eq(groupEnlistmentGrants.workspaceId, workspaceId),
          eq(groupEnlistmentGrants.channelId, channelId)
        )
      ),
  ])
  return {
    audienceGrants: audienceRows.map((row): GroupAudienceGrant => ({
      expiresAt: row.expiresAt,
      grantId: row.grantId,
      groupId: channelId,
      issuedAt: row.issuedAt,
      participant: { kind: 'user', userId: row.userId },
      revision: row.revision,
      revokedAt: row.revokedAt,
    })),
    enlistmentGrants: enlistmentRows.map(
      ({ grant, agentWorkspaceId }): GroupAgentEnlistmentGrant => ({
        agent: { agentId: grant.agentId, workspaceId: agentWorkspaceId },
        expiresAt: grant.expiresAt,
        grantId: grant.grantId,
        groupId: channelId,
        issuedAt: grant.issuedAt,
        revision: grant.revision,
        revokedAt: grant.revokedAt,
      })
    ),
  }
}

export type GroupSetFromSelectionInput = Readonly<{
  expectedVersion: number
  now: string
  selection: GroupSelection
}>

/**
 * Replace a group's roster from a selection, in one transaction with
 * optimistic concurrency. The channel row is locked first so the stored
 * grants read here cannot move before the roster is written; members whose
 * grants are still effective keep them exactly, and the unchanged roster
 * rewrite proves management authority, version and every member's standing.
 */
export async function setGroupChannelParticipantsFromSelection(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: GroupSetFromSelectionInput
): Promise<{ channel: ChannelSummary; roster: readonly GroupAdmission[] }> {
  return database.transaction(async (transaction) => {
    // Authority first: only a manager may take the channel lock below.
    await requireGroupManagementAuthority(transaction, workspaceId, principal)
    const [channel] = await transaction
      .select({
        kind: channels.kind,
        lifecycleState: channels.lifecycleState,
        version: channels.version,
      })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
      .limit(1)
      .for('update')
    if (!channel || channel.kind !== 'group' || channel.lifecycleState !== 'active')
      throw new Error('Channel unavailable')
    // Standing is read at exactly the version the caller saw. A removal
    // since then advanced it, so a stale roster is a conflict; a revocation
    // does not, and is caught by the retained member's grant state instead.
    if (channel.version !== input.expectedVersion) throw new Error('Channel version conflict')
    const issued = issueGroupGrants({
      groupId: channelId,
      now: input.now,
      roster: await loadGroupRoster(transaction, workspaceId, channelId),
      selection: input.selection,
      stored: await loadStoredGroupGrants(transaction, workspaceId, channelId),
    })
    const candidates: readonly GroupCreationCandidate[] = groupCreationCandidatesFromGrants(
      workspaceId,
      issued
    )
    const validation = validateGroupCreation({
      candidates,
      groupId: channelId,
      now: input.now,
      workspaceId,
    })
    if (!validation.ok) throw new GroupCreationError(validation.rejections)
    return setGroupChannelParticipantsInTransaction(
      transaction,
      workspaceId,
      channelId,
      principal,
      {
        candidates,
        expectedVersion: input.expectedVersion,
        now: input.now,
        roster: validation.roster,
      }
    )
  })
}
