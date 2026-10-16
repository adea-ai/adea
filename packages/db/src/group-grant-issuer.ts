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
 * Identity is stable so a save never disturbs people who are already in:
 * - first issuance uses a deterministic grant id at revision 1, so a retried
 *   creation hashes to the same payload and replays to the same group;
 * - a member whose stored grant is still effective keeps that exact grant, id
 *   and revision, so their retained admission binding (and any job bound to
 *   it) is untouched;
 * - only a member with no effective grant (never granted, expired or revoked)
 *   receives a fresh window, as a higher revision of the same grant, which is
 *   the regrant path the store already defines.
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
import { evaluateGroupGrantWindow, validateGroupCreation } from './group-participation-policy'
import {
  GroupCreationError,
  groupCreationCandidatesFromGrants,
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

/** The grant a selection will carry for one human or Agent, before standing is proven. */
export type IssuedGroupGrants = Readonly<{
  audienceGrants: readonly GroupAudienceGrant[]
  enlistmentGrants: readonly GroupAgentEnlistmentGrant[]
}>

/** What is already stored for the group, used only to keep members' grants stable. */
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

function keepsEffectiveGrant<T extends GroupAudienceGrant | GroupAgentEnlistmentGrant>(
  stored: readonly T[],
  now: string
): T | undefined {
  return stored
    .filter((grant) => evaluateGroupGrantWindow(grant, now) === 'effective')
    .toSorted((left, right) => right.revision - left.revision)[0]
}

/**
 * Issue the grants a selection needs for one group. Pure: reads only the
 * stored grants it is handed, so the same inputs always issue the same grants.
 */
export function issueGroupGrants(
  input: Readonly<{
    groupId: string
    now: string
    selection: GroupSelection
    stored?: StoredGroupGrants
  }>
): IssuedGroupGrants {
  const stored = input.stored ?? NO_STORED_GROUP_GRANTS
  const audienceGrants = input.selection.humans.map((userId): GroupAudienceGrant => {
    const forUser = stored.audienceGrants.filter((grant) => grant.participant.userId === userId)
    const effective = keepsEffectiveGrant(forUser, input.now)
    if (effective) return effective
    const grantId = audienceGrantIdFor(userId)
    const previous = forUser.find((grant) => grant.grantId === grantId)
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
    const effective = keepsEffectiveGrant(forAgent, input.now)
    if (effective)
      return {
        ...effective,
        agent: { agentId: agent.agentId, workspaceId: agent.workspaceId },
      }
    const grantId = enlistmentGrantIdFor(agent)
    const previous = forAgent.find((grant) => grant.grantId === grantId)
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
    await transaction
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
      .limit(1)
      .for('update')
    const issued = issueGroupGrants({
      groupId: channelId,
      now: input.now,
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
