/**
 * The effective group-standing read model (#1178).
 *
 * A read-only projection of one group's roster: for every member, the state of the grant that
 * governs their participation, the join point they read from, and when their access ends. It
 * answers the question the group-audience guide still lists as a backend gap — "joined at" and
 * "access ends" cannot be shown today — without inventing a second source of truth: the canonical
 * roster and the standing decision are the store's and the policy's, and this module only projects
 * them.
 *
 * The authorization is the canonical one, not a second gate. The read model applies the same chain
 * the product's own channel read applies — the workspace membership, the project-access scope, the
 * channel's existence and lifecycle, the project visibility, and the group admission or the
 * archived read rule — inside one read snapshot, so the decision and the facts it was made on are
 * the same ones. A retained admission is therefore never enough on its own: a member whose
 * workspace membership or project-read eligibility is gone learns nothing about the roster, even
 * while their group admission row is still there and still in force.
 *
 * The projection carries standing, never authority. It publishes the grant *state*, the join point
 * and the expiry. It never publishes the grant identity and revision, the issue or revocation
 * instants, the sharing grants that unlock earlier history, or any conversation content. A member's
 * standing can therefore be shown without handing out the token that authorizes them, and nothing
 * before a join point is exposed: the projection carries no message, no sequence and no content of
 * any kind.
 */

import type {
  ConversationParticipantRef,
  GroupGrantState,
  GroupJoinPoint,
  UserPrincipalRef,
} from '@adea-ai/types'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { requireChannelAccess } from './conversations'
import { evaluateGroupGrantWindow } from './group-participation-policy'
import {
  admissionForParticipant,
  admissionInForce,
  loadGroupRoster,
} from './group-participation-store'
import { inReadSnapshot } from './transactions'

/** One member's effective standing in one group. */
export type GroupStandingMember = Readonly<{
  /** When the member's access ends, or null when the grant does not expire. */
  expiresAt: string | null
  /** Whether the member's standing is effective right now. */
  inForce: boolean
  /** Where the member joined: the group's history they read from. */
  joinPoint: GroupJoinPoint
  /** The member's stable identity in the group. */
  participant: ConversationParticipantRef
  /** The state of the grant that governs this member's participation. */
  state: GroupGrantState
}>

/** The effective standing of one group, as one authorized requester may read it. */
export type GroupStandingReadModel = Readonly<{
  /** The group these standings belong to. */
  channelId: string
  /** Every member of the group's canonical roster. */
  members: readonly GroupStandingMember[]
  /**
   * The requester's own join point, or null when the requester holds no canonical admission.
   *
   * An archived group served to a retained legacy audience is the case: the canonical read allows
   * it, and that audience carries no canonical admission, so it has no join point to publish.
   */
  requesterJoinPoint: GroupJoinPoint | null
  /** The workspace that scopes the group. */
  workspaceId: string
}>

/**
 * Read one group's effective standing.
 *
 * The requester must pass the canonical read authorization for that channel — the same chain
 * `getChannelForUser` applies — so the standing read can never serve a reader the product's own
 * channel read would refuse. A refused requester learns nothing: the answer is the same
 * "Channel unavailable" the group's other readers give, and the roster is never read for them.
 *
 * The read is a listing, not a decision: it holds no lock, and the state it publishes is the state
 * at `now` inside one read snapshot.
 */
export async function readGroupStanding(
  database: AgentHqDatabase | AgentHqTransaction,
  input: Readonly<{
    /** The group to project. */
    channelId: string
    /** The instant the standing is evaluated at; the live clock by default. */
    now?: string
    /** The authenticated requester. */
    requester: UserPrincipalRef
    /** The workspace that scopes the group. */
    workspaceId: string
  }>
): Promise<GroupStandingReadModel> {
  const now = input.now ?? new Date().toISOString()
  return inReadSnapshot(database, async (snapshot) => {
    // The canonical read authorization. It proves the workspace membership, the project-access
    // scope, the channel's existence and lifecycle, the project visibility, and — for a group —
    // the requester's own in-force admission or the archived read rule. It runs before the roster
    // is read, so an unauthorized requester never materializes it.
    await requireChannelAccess(
      snapshot,
      input.workspaceId,
      input.channelId,
      input.requester,
      'read',
      false,
      now
    )
    const roster = await loadGroupRoster(snapshot, input.workspaceId, input.channelId)
    const requesterAdmission = admissionForParticipant(roster, {
      kind: 'user',
      userId: input.requester.userId,
    })
    return {
      channelId: input.channelId,
      members: roster.map((admission) => ({
        // The expiry is the access end the projection exists to publish.
        expiresAt: admission.grant.expiresAt,
        // A member stands only while the same decision the group's turns use allows it.
        inForce: admissionInForce(admission, input.channelId, now),
        // The join point is preserved exactly as the canonical admission holds it.
        joinPoint: admission.joinPoint,
        participant: admission.participant,
        // The grant state comes from the policy's own window evaluation.
        state: evaluateGroupGrantWindow(admission.grant, now),
      })),
      requesterJoinPoint: requesterAdmission?.joinPoint ?? null,
      workspaceId: input.workspaceId,
    }
  })
}
