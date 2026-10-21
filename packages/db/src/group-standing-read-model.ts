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
 * Two boundaries are deliberate.
 *
 * - **The requester must be authorized.** A principal reads the projection only while its own
 *   canonical admission is in force, which is the same decision the group's own reads and turns
 *   use. A stranger, a workspace member who was never admitted, and a member whose grant was
 *   revoked or expired all learn nothing — not even that the group exists.
 * - **The projection carries standing, never authority.** It publishes the grant *state*, the join
 *   point and the expiry. It never publishes the grant identity and revision, the issue or
 *   revocation instants, the sharing grants that unlock earlier history, or any conversation
 *   content. A member's standing can therefore be shown without handing out the token that
 *   authorizes them, and nothing before a join point is exposed: the projection carries no
 *   message, no sequence and no content of any kind.
 */

import type {
  ConversationParticipantRef,
  GroupGrantState,
  GroupJoinPoint,
  UserPrincipalRef,
} from '@adea-ai/types'

import { evaluateGroupGrantWindow } from './group-participation-policy'
import {
  admissionForParticipant,
  admissionInForce,
  loadGroupRoster,
  type GroupStoreDatabase,
} from './group-participation-store'

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
  /** The requester's own join point: the point their own reads start from. */
  requesterJoinPoint: GroupJoinPoint
  /** The workspace that scopes the group. */
  workspaceId: string
}>

/**
 * Read one group's effective standing.
 *
 * The requester must hold standing in that group right now; the check is the store's own
 * `admissionInForce`, so the read model cannot admit a reader the group's own readers would
 * refuse. A refused requester learns nothing: the answer is the same "Channel unavailable" the
 * group's other readers give.
 *
 * The projection is read-only and holds no lock: it is a listing, not a decision, and the state
 * it publishes is the state at `now`.
 */
export async function readGroupStanding(
  database: GroupStoreDatabase,
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
  const roster = await loadGroupRoster(database, input.workspaceId, input.channelId)
  const requesterAdmission = admissionForParticipant(roster, {
    kind: 'user',
    userId: input.requester.userId,
  })
  // The requester's own standing decides whether they may read the roster at all.
  if (!requesterAdmission || !admissionInForce(requesterAdmission, input.channelId, now)) {
    throw new Error('Channel unavailable')
  }
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
    requesterJoinPoint: requesterAdmission.joinPoint,
    workspaceId: input.workspaceId,
  }
}
