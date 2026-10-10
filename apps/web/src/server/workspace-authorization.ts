import 'server-only'

import { authorizeWorkspaceAction } from '@adea-ai/auth/authorization'
import {
  authorizeGroupChannelTurnNow,
  channels,
  findWorkspaceMembership,
  isMembersProjectEditorForConversation,
  recordWorkspaceAuthorizationDecision,
} from '@adea-ai/db'
import type { UserPrincipalRef, WorkspacePermission } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

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
  if (
    (await findWorkspaceMembership(applicationDatabase(), workspaceId, principal))?.deletionPending
  )
    return false
  if ((await authorizeWorkspace(principal, 'workspace.update', workspaceId)).allowed) return true
  if (!(await authorizeWorkspace(principal, 'workspace.read', workspaceId)).allowed) return false
  if (
    'channelId' in target &&
    (await isLiveGroupParticipant(principal, workspaceId, target.channelId))
  )
    return true
  return isMembersProjectEditorForConversation(
    applicationDatabase(),
    workspaceId,
    principal.userId,
    target
  )
}

/**
 * A live canonical group admission is the write authority for a group channel:
 * the participant holds an explicit, unexpired, unrevoked audience grant and
 * the channel gate is open. Workspace membership alone never qualifies, and the
 * workspace-wide write role is not required. The group fence re-evaluates the
 * same decision atomically with the write, so this pre-gate only refuses early.
 */
async function isLiveGroupParticipant(
  principal: UserPrincipalRef,
  workspaceId: string,
  channelId: string
): Promise<boolean> {
  const database = applicationDatabase()
  const [channel] = await database
    .select({ kind: channels.kind })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.id, channelId)))
    .limit(1)
  if (channel?.kind !== 'group') return false
  const decision = await authorizeGroupChannelTurnNow(
    database,
    workspaceId,
    channelId,
    { kind: 'user', userId: principal.userId },
    new Date().toISOString()
  )
  return decision.action === 'allow'
}
