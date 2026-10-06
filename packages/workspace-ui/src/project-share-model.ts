import type {
  ProjectMemberSummary,
  WorkspaceInvitationSummary,
  WorkspaceMemberSummary,
} from '@adea-ai/types'

export function memberLabel(member: Readonly<{ displayName: string | null; userId: string }>) {
  return member.displayName?.trim() || `Member ${member.userId.slice(0, 8)}`
}

/** Only workspace owners and admins change sharing; the server enforces the same rule. */
export function canManageSharing(
  members: readonly WorkspaceMemberSummary[],
  userId: string | undefined
): boolean {
  const own = members.find((member) => member.userId === userId)
  return own?.role === 'owner' || own?.role === 'admin'
}

/** Workspace members not yet on the project, as combobox choices. */
export function shareCandidates(
  members: readonly WorkspaceMemberSummary[],
  listed: readonly ProjectMemberSummary[]
) {
  const onProject = new Set(listed.map(({ userId }) => userId))
  return members
    .filter(({ userId }) => !onProject.has(userId))
    .map((member) => ({ label: memberLabel(member), value: member.userId }))
}

/**
 * Invitations an owner or admin can still revoke: pending and not yet past
 * their expiry, newest first. Accepted, revoked and expired links drop out.
 */
export function pendingInvitations(
  invitations: readonly WorkspaceInvitationSummary[],
  now: Date = new Date()
): readonly WorkspaceInvitationSummary[] {
  return invitations
    .filter(
      (invitation) =>
        invitation.state === 'pending' && Date.parse(invitation.expiresAt) > now.getTime()
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
}

/** "Member · expires Oct 9" style detail for a pending invitation row. */
export function invitationDetail(
  invitation: Pick<WorkspaceInvitationSummary, 'expiresAt' | 'role'>,
  locale?: string
): string {
  const role = invitation.role === 'admin' ? 'Admin' : 'Member'
  const expires = new Date(invitation.expiresAt).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
  return `${role} · expires ${expires}`
}
