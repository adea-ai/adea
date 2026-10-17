/*
 * Pure grant issuance for server-selected group rosters (M15 #1178).
 *
 * Turns a selection plus the roster and stored grants it is handed into the
 * explicit grants the group policy consumes. It reads no database: the
 * transactional callers live in `group-grant-issuer.ts`, which owns the rules
 * for when this runs (channel lock, version check, standing checks). See that
 * file for the full safety argument: retained members keep the exact bound
 * grant (id and revision) or the save is refused, and only a person who is not
 * on the roster is issued a new, higher revision.
 */
import type {
  ConversationParticipantRef,
  GroupAdmission,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
  GroupCreationRejection,
  QualifiedAgentIdentity,
} from '@adea-ai/types'

import { GroupCreationError } from './group-participation-store'

/**
 * Who a group should contain, by stable identity. `humans` are user ids;
 * `agents` are workspace-qualified, so two Agents that share a display name
 * are different entries and nothing is ever resolved by name.
 */
export type GroupSelection = Readonly<{
  agents: readonly QualifiedAgentIdentity[]
  humans: readonly string[]
}>

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
  grants: readonly T[]
): T | undefined {
  return grants.toSorted((left, right) => right.revision - left.revision)[0]
}

/**
 * The stored grant a retained admission is bound to: exactly its grant id and
 * revision, or nothing. A binding that is absent from storage, or whose
 * revision is no longer the stored one, is never repaired by picking another
 * grant or issuing a fresh one; the caller refuses the save instead.
 */
function boundGrant<T extends GroupAudienceGrant | GroupAgentEnlistmentGrant>(
  grants: readonly T[],
  binding: GroupAdmission['authorization']
): T | undefined {
  return grants.find(
    (grant) => grant.grantId === binding.grantId && grant.revision === binding.revision
  )
}

/**
 * Issue the grants a selection needs for one group. Pure: reads only the
 * stored grants and the roster it is handed, so the same inputs always issue
 * the same grants. `roster` is the group's current admissions; with none, every
 * identity is a first issuance. An identity that is on the roster must still
 * hold the exact grant (id and revision) its admission is bound to; if storage
 * no longer holds that binding, the whole request is refused with a
 * `GroupCreationError` and nothing is issued.
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
  const refusals: GroupCreationRejection[] = []
  const refuse = (
    candidateIndex: number,
    participant: ConversationParticipantRef,
    sameId: boolean
  ) => {
    refusals.push({
      candidateIndex,
      participant,
      reason: sameId ? 'grant_revision_invalid' : 'grant_absent',
      scope: 'candidate',
    })
  }
  const audienceGrants = input.selection.humans.map((userId, index): GroupAudienceGrant => {
    const forUser = stored.audienceGrants.filter((grant) => grant.participant.userId === userId)
    const admission = roster.find(
      ({ participant }) => participant.kind === 'user' && participant.userId === userId
    )
    const grantId = audienceGrantIdFor(userId)
    const fresh = (): GroupAudienceGrant => ({
      expiresAt: null,
      grantId,
      groupId: input.groupId,
      issuedAt: input.now,
      participant: { kind: 'user', userId },
      revision:
        (highestRevision(forUser.filter((grant) => grant.grantId === grantId))?.revision ?? 0) + 1,
      revokedAt: null,
    })
    if (!admission) return fresh()
    const held = boundGrant(forUser, admission.authorization)
    if (held) return held
    refuse(
      index,
      { kind: 'user', userId },
      forUser.some((grant) => grant.grantId === admission.authorization.grantId)
    )
    return fresh()
  })
  const enlistmentGrants = input.selection.agents.map((agent, index): GroupAgentEnlistmentGrant => {
    const forAgent = stored.enlistmentGrants.filter(
      (grant) => grant.agent.agentId === agent.agentId
    )
    const admission = roster.find(
      ({ participant }) => participant.kind === 'agent' && participant.agentId === agent.agentId
    )
    const qualified = { agentId: agent.agentId, workspaceId: agent.workspaceId }
    const grantId = enlistmentGrantIdFor(agent)
    const fresh = (): GroupAgentEnlistmentGrant => ({
      agent: qualified,
      expiresAt: null,
      grantId,
      groupId: input.groupId,
      issuedAt: input.now,
      revision:
        (highestRevision(forAgent.filter((grant) => grant.grantId === grantId))?.revision ?? 0) + 1,
      revokedAt: null,
    })
    if (!admission) return fresh()
    const held = boundGrant(forAgent, admission.authorization)
    if (held) return { ...held, agent: qualified }
    refuse(
      input.selection.humans.length + index,
      { agentId: agent.agentId, kind: 'agent' },
      forAgent.some((grant) => grant.grantId === admission.authorization.grantId)
    )
    return fresh()
  })
  if (refusals.length > 0) throw new GroupCreationError(refusals)
  return { audienceGrants, enlistmentGrants }
}
