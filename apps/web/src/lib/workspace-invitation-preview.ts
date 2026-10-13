import type { ApiWorkspaceInvitationPreviewResponse } from '@adea-ai/api-client'

/**
 * Copy for the invitation page, stated from the preview record only: who owns the workspace, how
 * many people are in it now, and the role the account holds. For someone who is not in the
 * workspace that is the invitation's role; for an existing member it is their current role, which
 * accepting leaves alone. Where the workspace's work runs is not part of an invitation, so
 * placement says it is unknown rather than guessing (the create surface uses the same wording
 * until a host supplies a location).
 */
export function invitationRoleLabel(role: ApiWorkspaceInvitationPreviewResponse['role']): string {
  return role === 'owner' ? 'the owner' : role === 'admin' ? 'an admin' : 'a member'
}

export function describeInvitationContext(preview: ApiWorkspaceInvitationPreviewResponse): string {
  const owner = preview.ownerName ? `Owned by ${preview.ownerName}` : 'Owner not named'
  const members = `${preview.memberCount} ${preview.memberCount === 1 ? 'member' : 'members'} now`
  const role = preview.alreadyMember
    ? `You are already ${invitationRoleLabel(preview.role)}`
    : `You would join as ${invitationRoleLabel(preview.role)}`
  return `${owner} · ${members} · ${role} · Location unknown`
}
