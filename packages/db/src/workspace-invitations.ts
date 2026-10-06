import { createHash, randomBytes } from 'node:crypto'

import type {
  UserPrincipalRef,
  WorkspaceInvitationRole,
  WorkspaceInvitationState,
  WorkspaceInvitationSummary,
  WorkspaceMemberSummary,
} from '@adea-ai/types'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { appendWorkspaceEvent } from './transactions'
import { users, workspaceInvitations, workspaceMemberships, workspaces } from './schema'

/**
 * Workspace invitations (ADR 0012).
 *
 * An invitation carries a single-use token: 32 random bytes, base64url. Only
 * its SHA-256 digest is stored; the plaintext is returned once to the inviter
 * and travels as a copyable link (no email is sent). Accepting requires an
 * account signed in with the invited email, so a leaked link alone does not
 * grant membership.
 */

export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/

type Database = AgentHqDatabase | AgentHqTransaction
type InvitationRow = typeof workspaceInvitations.$inferSelect

export function normalizeInvitationEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length >= 3 && email.length <= 320 && EMAIL_PATTERN.test(email) ? email : null
}

export function isWorkspaceInvitationRole(value: unknown): value is WorkspaceInvitationRole {
  return value === 'admin' || value === 'member'
}

export function isInvitationToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}

export function digestInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function invitationState(row: InvitationRow, now: Date): WorkspaceInvitationState {
  if (row.acceptedAt) return 'accepted'
  if (row.revokedAt) return 'revoked'
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending'
}

function invitationSummary(row: InvitationRow, now = new Date()): WorkspaceInvitationSummary {
  return Object.freeze({
    ...(row.acceptedAt ? { acceptedAt: row.acceptedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    email: row.email,
    expiresAt: row.expiresAt.toISOString(),
    id: row.id,
    invitedByUserId: row.invitedByUserId,
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
    role: row.role,
    state: invitationState(row, now),
    workspaceId: row.workspaceId,
  })
}

async function requireMembershipManager(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  const [membership] = await database
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId),
        isNull(workspaces.deletedAt)
      )
    )
    .limit(1)
  // Mirrors `membership.manage` in @adea-ai/auth: owners and admins only.
  if (!membership || membership.role === 'member') throw new Error('Invitation unavailable')
}

/** Every member of a workspace, for other members to pick from. No emails. */
export async function listWorkspaceMembersForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<readonly WorkspaceMemberSummary[]> {
  const [own] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!own) throw new Error('Workspace unavailable')
  const rows = await database
    .select({
      createdAt: workspaceMemberships.createdAt,
      displayName: users.displayName,
      role: workspaceMemberships.role,
      userId: workspaceMemberships.userId,
    })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .where(eq(workspaceMemberships.workspaceId, workspaceId))
    .orderBy(asc(workspaceMemberships.createdAt), asc(workspaceMemberships.userId))
  return Object.freeze(
    rows.map(({ displayName, role, userId }) => Object.freeze({ displayName, role, userId }))
  )
}

/**
 * Invite an email into a workspace. A pending invitation for the same email is
 * replaced (revoked) rather than refused: the plaintext token is shown only
 * once, so re-inviting is how an inviter gets a fresh link.
 */
export async function createWorkspaceInvitation(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ email: string; role: WorkspaceInvitationRole }>,
  now = new Date()
): Promise<Readonly<{ invitation: WorkspaceInvitationSummary; token: string }>> {
  const email = normalizeInvitationEmail(input.email)
  if (!email || !isWorkspaceInvitationRole(input.role)) throw new Error('Invitation invalid')
  return database.transaction(async (transaction) => {
    await requireMembershipManager(transaction, workspaceId, principal)
    const replaced = await transaction
      .update(workspaceInvitations)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(workspaceInvitations.workspaceId, workspaceId),
          eq(workspaceInvitations.email, email),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt)
        )
      )
      .returning({ id: workspaceInvitations.id })
    for (const { id } of replaced) {
      await appendWorkspaceEvent(transaction, {
        eventType: 'workspace.invitation_revoked',
        payload: { actorUserId: principal.userId, invitationId: id },
        workspaceId,
      })
    }
    const token = randomBytes(32).toString('base64url')
    const [created] = await transaction
      .insert(workspaceInvitations)
      .values({
        email,
        expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS),
        invitedByUserId: principal.userId,
        role: input.role,
        tokenDigest: digestInvitationToken(token),
        workspaceId,
      })
      .returning()
    if (!created) throw new Error('Invitation creation failed')
    await appendWorkspaceEvent(transaction, {
      eventType: 'workspace.member_invited',
      payload: { actorUserId: principal.userId, invitationId: created.id },
      workspaceId,
    })
    return Object.freeze({ invitation: invitationSummary(created, now), token })
  })
}

export async function listWorkspaceInvitationsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  now = new Date()
): Promise<readonly WorkspaceInvitationSummary[]> {
  await requireMembershipManager(database, workspaceId, principal)
  const rows = await database
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, workspaceId))
    .orderBy(desc(workspaceInvitations.createdAt), asc(workspaceInvitations.id))
    .limit(200)
  return Object.freeze(rows.map((row) => invitationSummary(row, now)))
}

export async function revokeWorkspaceInvitation(
  database: AgentHqDatabase,
  workspaceId: string,
  invitationId: string,
  principal: UserPrincipalRef,
  now = new Date()
): Promise<WorkspaceInvitationSummary> {
  return database.transaction(async (transaction) => {
    await requireMembershipManager(transaction, workspaceId, principal)
    const [existing] = await transaction
      .select()
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.id, invitationId),
          eq(workspaceInvitations.workspaceId, workspaceId)
        )
      )
      .limit(1)
    if (!existing) throw new Error('Invitation unavailable')
    if (existing.acceptedAt) throw new Error('Invitation already accepted')
    if (existing.revokedAt) return invitationSummary(existing, now)
    const [revoked] = await transaction
      .update(workspaceInvitations)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(eq(workspaceInvitations.id, invitationId), isNull(workspaceInvitations.acceptedAt))
      )
      .returning()
    if (!revoked) throw new Error('Invitation already accepted')
    await appendWorkspaceEvent(transaction, {
      eventType: 'workspace.invitation_revoked',
      payload: { actorUserId: principal.userId, invitationId },
      workspaceId,
    })
    return invitationSummary(revoked, now)
  })
}

export type WorkspaceInvitationAcceptance = Readonly<{
  /** False when the principal was already a member; the role is left unchanged. */
  joined: boolean
  workspaceId: string
}>

/**
 * Accept an invitation with its plaintext token. Single use: the first
 * acceptance settles it, a replay by the same user is idempotent, and anyone
 * else — or a revoked, expired or mismatched-email attempt — is answered with
 * the same `Invitation unavailable` so a token cannot be probed.
 */
export async function acceptWorkspaceInvitation(
  database: AgentHqDatabase,
  principal: UserPrincipalRef,
  input: Readonly<{ email: string | null; token: string }>,
  now = new Date()
): Promise<WorkspaceInvitationAcceptance> {
  if (!isInvitationToken(input.token)) throw new Error('Invitation unavailable')
  const email = normalizeInvitationEmail(input.email)
  const tokenDigest = digestInvitationToken(input.token)
  return database.transaction(async (transaction) => {
    const [invitation] = await transaction
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.tokenDigest, tokenDigest))
      .for('update')
      .limit(1)
    if (!invitation) throw new Error('Invitation unavailable')
    if (invitation.acceptedAt) {
      if (invitation.acceptedByUserId === principal.userId)
        return Object.freeze({ joined: false, workspaceId: invitation.workspaceId })
      throw new Error('Invitation unavailable')
    }
    if (
      invitation.revokedAt ||
      invitation.expiresAt.getTime() <= now.getTime() ||
      !email ||
      email !== invitation.email
    )
      throw new Error('Invitation unavailable')
    const [workspace] = await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, invitation.workspaceId), isNull(workspaces.deletedAt)))
      .limit(1)
    if (!workspace) throw new Error('Invitation unavailable')

    const inserted = await transaction
      .insert(workspaceMemberships)
      .values({
        role: invitation.role,
        // Appended to the joiner's own workspace order.
        sortOrder: sql`(select coalesce(max(${workspaceMemberships.sortOrder}) + 1, 0) from ${workspaceMemberships} where ${workspaceMemberships.userId} = ${principal.userId})`,
        userId: principal.userId,
        workspaceId: invitation.workspaceId,
      })
      .onConflictDoNothing({
        target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      })
      .returning({ id: workspaceMemberships.id })
    await transaction
      .update(workspaceInvitations)
      .set({ acceptedAt: now, acceptedByUserId: principal.userId, updatedAt: now })
      .where(eq(workspaceInvitations.id, invitation.id))
    const joined = inserted.length === 1
    if (joined) {
      await appendWorkspaceEvent(transaction, {
        eventType: 'workspace.member_joined',
        payload: {
          actorUserId: principal.userId,
          invitationId: invitation.id,
          userId: principal.userId,
        },
        workspaceId: invitation.workspaceId,
      })
    }
    return Object.freeze({ joined, workspaceId: invitation.workspaceId })
  })
}
