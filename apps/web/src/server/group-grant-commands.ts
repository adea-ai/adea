/**
 * Group grant commands (M15.01, adea-ai/adea#1178).
 *
 * Two commands act on one group's participation grants: revoke a grant, and
 * share earlier material with one exact participant. Each command wraps the
 * store behaviour that already exists — `revokeGroupGrant` and
 * `shareGroupHistory` — and owns the part the store deliberately leaves to
 * its caller:
 *
 * - The caller's resolved principal is forwarded unchanged. The command never
 *   mints, substitutes or elevates a principal, and it never decides who may
 *   act: group-management authority is the store's rule, and the command does
 *   not widen it.
 * - The group and the participant are the exact ones the command names. A
 *   command that names a different group, or a participant that is not a
 *   participant, authorizes nothing.
 * - Every timestamp the command writes is the server's own. A caller supplies
 *   a window, never an instant: the issue instant and the expiry are both
 *   derived from the server's clock, so a grant can never be backdated.
 * - Earlier history and earlier summary are separately grantable, and one
 *   never implies the other. The scope is explicit in the command and is
 *   carried through unchanged.
 * - Every refusal is the same refusal, so a caller cannot learn from the
 *   answer whether a group, a grant or a participant exists.
 * - A revocation is effective immediately and leaves the independently owned
 *   job alone: the command calls the store once and changes nothing else.
 *
 * The store operations are injected, and their types are taken from the
 * store's own exports, so this surface cannot drift from the behaviour it
 * wraps and it imports no database. Wiring the exported
 * `revokeGroupGrant` and `shareGroupHistory` into these commands, and the
 * route or lead surface that calls them, is the remaining integration gate and
 * is outside this packet.
 */
import type {
  AgentHqDatabase,
  GroupGrantKind,
  revokeGroupGrant,
  shareGroupHistory,
} from '@adea-ai/db'
import type {
  ConversationParticipantRef,
  GroupSharingGrant,
  GroupSharingScope,
  UserPrincipalRef,
} from '@adea-ai/types'

/** The store operations these commands wrap, typed by the store's own exports. */
export type GroupGrantOperations = Readonly<{
  revokeGroupGrant: typeof revokeGroupGrant
  shareGroupHistory: typeof shareGroupHistory
}>

/** Everything a command needs besides its own input. */
export type GroupGrantCommandDependencies = Readonly<{
  /** The store operations, wrapped by the commands. */
  operations: GroupGrantOperations
  /** The database the commands act on. */
  database: AgentHqDatabase
  /** The caller the request authenticated as. It is forwarded, never made. */
  principal: UserPrincipalRef
  /** The server's clock. Every timestamp the commands write comes from it. */
  now?(): Date
}>

/** The group a command acts on. A command authorizes nothing in another group. */
export type GroupGrantCommandTarget = Readonly<{
  /** The group the command names; it must be the group the command acts on. */
  groupId: string
  workspaceId: string
}>

/** Revoke one participation grant of one group. */
export type GroupGrantRevokeCommand = GroupGrantCommandTarget &
  Readonly<{
    /** The exact grant to revoke. */
    grantId: string
    /** Which family of participation grant it is. */
    kind: GroupGrantKind
  }>

/**
 * Share earlier material with one exact participant.
 *
 * The scope is explicit: `earlier_history` shares the material before the
 * participant's join point, `earlier_summary` shares only the summary. A
 * command that names neither is refused, and one scope never implies the
 * other.
 */
export type GroupGrantShareCommand = GroupGrantCommandTarget &
  Readonly<{
    /** How long the share lives, in milliseconds. `null` never expires. */
    expiresInMs: number | null
    /** The exact participant the earlier material is shared with. */
    participant: ConversationParticipantRef
    /** The grant identity. A re-issuance carries a higher revision. */
    grantId: string
    /** The issuance revision. A stale revision never supersedes a newer one. */
    revision: number
    /** Which earlier material is shared. */
    scope: GroupSharingScope
  }>

/** The one refusal every failed command returns. */
export type GroupGrantCommandRefusal = Readonly<{
  code: 'group_grant_unavailable'
  ok: false
}>

export type GroupGrantRevokeOutcome =
  | Readonly<{ ok: true; revoked: boolean }>
  | GroupGrantCommandRefusal

export type GroupGrantShareOutcome = Readonly<{ ok: true }> | GroupGrantCommandRefusal

const GROUP_GRANT_KINDS: readonly GroupGrantKind[] = ['audience', 'enlistment', 'sharing']
const GROUP_SHARING_SCOPES: readonly GroupSharingScope[] = ['earlier_history', 'earlier_summary']

const UNAVAILABLE: GroupGrantCommandRefusal = Object.freeze({
  code: 'group_grant_unavailable',
  ok: false,
})

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The exact participant a share names: a human or an Agent, never a guess. */
function readParticipant(value: unknown): ConversationParticipantRef | null {
  if (!isPlainRecord(value)) return null
  if (value.kind === 'user') {
    return nonBlankString(value.userId) ? { kind: 'user', userId: value.userId } : null
  }
  if (value.kind === 'agent') {
    return nonBlankString(value.agentId) ? { kind: 'agent', agentId: value.agentId } : null
  }
  return null
}

function serverNow(dependencies: GroupGrantCommandDependencies): Date {
  const now = dependencies.now?.()
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
}

/**
 * Revoke one participation grant.
 *
 * The revocation is effective immediately: the store marks the grant revoked
 * in the same transaction that denies the next read, and the independently
 * owned job is left exactly as it was. Revoking a grant that is already
 * revoked reports `revoked: false` and changes nothing; a grant that does not
 * exist, a group the caller does not name, and a caller without
 * group-management authority all return the same refusal.
 */
export async function revokeGroupGrantCommand(
  command: GroupGrantRevokeCommand,
  dependencies: GroupGrantCommandDependencies
): Promise<GroupGrantRevokeOutcome> {
  if (
    !nonBlankString(command.groupId) ||
    !nonBlankString(command.workspaceId) ||
    !nonBlankString(command.grantId) ||
    !GROUP_GRANT_KINDS.includes(command.kind)
  )
    return UNAVAILABLE
  try {
    const revoked = await dependencies.operations.revokeGroupGrant(
      dependencies.database,
      command.workspaceId,
      command.groupId,
      dependencies.principal,
      {
        grantId: command.grantId,
        kind: command.kind,
        revokedAt: serverNow(dependencies).toISOString(),
      }
    )
    return Object.freeze({ ok: true, revoked: revoked.revoked })
  } catch {
    // A refusal never says which part was wrong.
    return UNAVAILABLE
  }
}

/**
 * Share earlier material with one exact participant of one exact group.
 *
 * The issue instant and the expiry are the server's own, so a grant can never
 * be backdated and its window cannot be widened by the caller. The scope is
 * explicit: an earlier-history share and an earlier-summary share are
 * separately grantable and one never implies the other.
 */
export async function shareGroupHistoryCommand(
  command: GroupGrantShareCommand,
  dependencies: GroupGrantCommandDependencies
): Promise<GroupGrantShareOutcome> {
  const participant = readParticipant(command.participant)
  if (
    !nonBlankString(command.groupId) ||
    !nonBlankString(command.workspaceId) ||
    !nonBlankString(command.grantId) ||
    !participant ||
    !GROUP_SHARING_SCOPES.includes(command.scope) ||
    !Number.isSafeInteger(command.revision) ||
    command.revision < 1 ||
    (command.expiresInMs !== null &&
      (!Number.isSafeInteger(command.expiresInMs) || command.expiresInMs < 0))
  )
    return UNAVAILABLE
  const issuedAt = serverNow(dependencies)
  const grant: GroupSharingGrant = Object.freeze({
    expiresAt:
      command.expiresInMs === null
        ? null
        : new Date(issuedAt.getTime() + command.expiresInMs).toISOString(),
    grantId: command.grantId,
    groupId: command.groupId,
    issuedAt: issuedAt.toISOString(),
    participant,
    revision: command.revision,
    revokedAt: null,
    scope: command.scope,
  })
  try {
    await dependencies.operations.shareGroupHistory(
      dependencies.database,
      command.workspaceId,
      command.groupId,
      dependencies.principal,
      grant
    )
    return Object.freeze({ ok: true })
  } catch {
    // A refusal never says which part was wrong.
    return UNAVAILABLE
  }
}
