import type { UserPrincipalRef } from '@adea-ai/types'

/**
 * The server read of one group's effective standing (#1178).
 *
 * The canonical projection — the roster, the grant state, the join point and the expiry — is the
 * database package's business, and the authorization behind it is proven there: the read applies the
 * same chain the product's own channel read applies — the workspace membership, the project-access
 * scope, the channel's existence and lifecycle, the project visibility, and the group admission or
 * the archived read rule — so a retained admission alone never exposes the roster. This surface
 * adds the two things that belong to the application:
 *
 * - **The requester is the authenticated principal.** It arrives as an argument and is never read
 *   from a request body, a query string or a header this module parses, so a caller can never ask
 *   for another member's standing. A request with no principal is refused before any read happens.
 * - **The wire shape carries standing, never authority.** The response is written out field by
 *   field, so a field the canonical projection grows later cannot reach a client by accident. The
 *   grant identity and revision, the issue and revocation instants, the sharing grants that unlock
 *   earlier history and every conversation content stay behind the database boundary.
 *
 * The route that will serve this read is out of scope here: the route composes the canonical read
 * into this surface and maps the refusal to the shared unavailable response.
 *
 * The surface holds no database handle of its own — the canonical read is injected — so it is
 * composed by a server route and stays importable from an ordinary test lane.
 */

/** The state a member's standing can be in. */
export type GroupStandingState = 'effective' | 'expired' | 'not_yet_issued' | 'revoked'

/** The wire shape of one member's standing. */
export type GroupStandingMemberRead = Readonly<{
  /** When the member's access ends, or null when it does not expire. */
  expiresAt: string | null
  /** Whether the member's standing is effective right now. */
  inForce: boolean
  /** When the member joined the group. */
  joinedAt: string
  /** The group's history the member reads from. */
  joinedSequence: number
  /** The member's stable identity in the group. */
  participant:
    | Readonly<{ kind: 'user'; userId: string }>
    | Readonly<{ agentId: string; kind: 'agent' }>
  /** The state of the grant that governs the member's participation. */
  state: GroupStandingState
}>

/** The wire shape of one group's effective standing. */
export type GroupStandingRead = Readonly<{
  /** The group these standings belong to. */
  channelId: string
  /** Every member of the group's canonical roster. */
  members: readonly GroupStandingMemberRead[]
}>

/**
 * The canonical projection this surface consumes.
 *
 * The database package publishes the read model with this shape; the surface states it here
 * because the database package's exports are the package's own, and the route that composes the
 * two is the point where the two meet.
 */
export type GroupStandingSource = Readonly<{
  /** The group these standings belong to. */
  channelId: string
  /** Every member of the group's canonical roster. */
  members: readonly Readonly<{
    /** When the member's access ends, or null when it does not expire. */
    expiresAt: string | null
    /** Whether the member's standing is effective right now. */
    inForce: boolean
    /** Where the member joined: the group's history they read from. */
    joinPoint: Readonly<{ joinedAt: string; joinedSequence: number }>
    /** The member's stable identity in the group. */
    participant:
      | Readonly<{ kind: 'user'; userId: string }>
      | Readonly<{ agentId: string; kind: 'agent' }>
    /** The state of the grant that governs the member's participation. */
    state: GroupStandingState
  }>[]
}>

/** The refusal this surface gives for a request it will not serve. */
export class GroupStandingUnavailableError extends Error {
  readonly code = 'group_standing_unavailable'

  constructor() {
    super('Channel unavailable')
    this.name = 'GroupStandingUnavailableError'
  }
}

/**
 * Read one group's effective standing for an authenticated requester.
 *
 * The canonical read proves the requester's own standing and refuses everyone else; that refusal
 * is not translated here, because a denial and a failure are different answers and only the
 * canonical layer knows which one it is. What this surface refuses on its own is a request that
 * carries no authenticated principal or no group: those never reach the database at all.
 */
export async function readGroupStanding(
  requester: UserPrincipalRef,
  channelId: string,
  dependencies: Readonly<{
    /** The canonical read: it proves the requester's standing and refuses everyone else. */
    readStanding: (
      input: Readonly<{ channelId: string; requester: UserPrincipalRef }>
    ) => Promise<GroupStandingSource>
  }>
): Promise<GroupStandingRead> {
  if (!requester || typeof requester.userId !== 'string' || !requester.userId.trim()) {
    throw new GroupStandingUnavailableError()
  }
  if (typeof channelId !== 'string' || !channelId.trim()) {
    throw new GroupStandingUnavailableError()
  }
  const source = await dependencies.readStanding({ channelId, requester })
  return {
    channelId: source.channelId,
    // The wire shape is written out field by field. Nothing else the canonical projection holds
    // can reach a client: no grant identity, no revision, no issue or revocation instant, no
    // sharing grant and no content.
    members: source.members.map((member) => ({
      expiresAt: member.expiresAt,
      inForce: member.inForce,
      joinedAt: member.joinPoint.joinedAt,
      joinedSequence: member.joinPoint.joinedSequence,
      participant:
        member.participant.kind === 'user'
          ? { kind: 'user', userId: member.participant.userId }
          : { agentId: member.participant.agentId, kind: 'agent' },
      state: member.state,
    })),
  }
}
