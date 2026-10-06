import type { ProjectMemberSummary, WorkspaceMemberSummary } from '@adea-ai/types'

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
