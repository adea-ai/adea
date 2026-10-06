import 'server-only'

import { authorizeWorkspaceAction } from '@adea-ai/auth/authorization'
import {
  findWorkspaceMembership,
  isMembersProjectEditorForConversation,
  recordWorkspaceAuthorizationDecision,
} from '@adea-ai/db'
import type { UserPrincipalRef, WorkspacePermission } from '@adea-ai/types'

import { applicationDatabase } from './database'

export async function authorizeWorkspace(
  principal: UserPrincipalRef,
  permission: WorkspacePermission,
  workspaceId: string | null,
  options: Readonly<{ includeArchived?: boolean }> = {}
) {
  const database = applicationDatabase()
  return authorizeWorkspaceAction(
    { permission, principal, workspaceId },
    {
      audit: (record) => recordWorkspaceAuthorizationDecision(database, record),
      findMembership: ({ principal: member, workspaceId: id }) =>
        findWorkspaceMembership(database, id, member, options),
    }
  )
}

/**
 * Authorization for writing a conversation (posting, editing or deleting a
 * message). The workspace-wide write role (`workspace.update`) still applies
 * everywhere; an `editor` of a members-only project may additionally write in
 * that project's channels (ADR 0012). The query layer re-checks read access
 * and refuses viewers either way.
 */
export async function authorizeConversationWrite(
  principal: UserPrincipalRef,
  workspaceId: string,
  target: Readonly<{ channelId: string } | { messageId: string }>
): Promise<boolean> {
  if ((await authorizeWorkspace(principal, 'workspace.update', workspaceId)).allowed) return true
  if (!(await authorizeWorkspace(principal, 'workspace.read', workspaceId)).allowed) return false
  return isMembersProjectEditorForConversation(
    applicationDatabase(),
    workspaceId,
    principal.userId,
    target
  )
}
