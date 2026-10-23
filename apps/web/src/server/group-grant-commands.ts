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
 * - The group and the participant are the exact ones the command names, and a
 *   command that names another group is refused. The command does not decide
 *   whether that participant is a live member of the workspace, and it does not
 *   decide whether the window is honoured: the store persists the grant, and a
 *   share takes effect only where the reader already holds a valid admission
 *   and the grant window is effective.
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
 * The scope is explicit: `earlier_history` authorizes the material before the
 * participant's join point, `earlier_summary` authorizes only the summary. A
 * command that names neither is refused, and one scope never implies the
 * other. Issuing the share admits nobody: it takes effect only where that
 * participant already holds a valid admission.
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

/**
 * The server's own clock.
 *
 * A clock that fails, or that hands back an instant the calendar cannot
 * represent, leaves the command without a trustworthy timestamp. The command
 * then refuses: it never writes an instant of its own making in place of the
 * server's.
 */
function serverNow(dependencies: GroupGrantCommandDependencies): Date | null {
  if (!dependencies.now) {
    const wall = new Date()
    return Number.isNaN(wall.getTime()) ? null : wall
  }
  let now: Date
  try {
    now = dependencies.now()
  } catch {
    return null
  }
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : null
}

/**
 * The expiry the server writes for a share.
 *
 * A duration the calendar cannot represent is refused rather than serialized:
 * `toISOString` throws outside the representable range, and that throw must
 * never escape as a crash instead of the documented refusal. The refusal
 * happens before the store is called, so an unrepresentable window never
 * reaches a grant row.
 */
function shareExpiry(
  issuedAt: Date,
  expiresInMs: number | null
): Readonly<{ expiresAt: string | null }> | null {
  if (expiresInMs === null) return { expiresAt: null }
  const expiry = new Date(issuedAt.getTime() + expiresInMs)
  if (Number.isNaN(expiry.getTime())) return null
  return { expiresAt: expiry.toISOString() }
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
  const revokedAt = serverNow(dependencies)
  // A clock that failed leaves the command without a trustworthy instant.
  if (!revokedAt) return UNAVAILABLE
  try {
    const revoked = await dependencies.operations.revokeGroupGrant(
      dependencies.database,
      command.workspaceId,
      command.groupId,
      dependencies.principal,
      {
        grantId: command.grantId,
        kind: command.kind,
        revokedAt: revokedAt.toISOString(),
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
 * be backdated and its window cannot be widened by the caller. A window the
 * calendar cannot represent, and a clock that failed, are refused before the
 * store is called. The scope is explicit: an earlier-history share and an
 * earlier-summary share are separately grantable and one never implies the
 * other.
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
  if (!issuedAt) return UNAVAILABLE
  const expiry = shareExpiry(issuedAt, command.expiresInMs)
  // A window the calendar cannot represent is refused before the store is
  // called, so no grant row ever carries an instant nobody can read.
  if (!expiry) return UNAVAILABLE
  const grant: GroupSharingGrant = Object.freeze({
    expiresAt: expiry.expiresAt,
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
