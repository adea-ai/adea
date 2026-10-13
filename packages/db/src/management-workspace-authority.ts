import { workspaceRolePermissions } from '@adea-ai/auth/authorization'
import type { UserPrincipalRef, WorkspacePermission } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { workspaceMemberships, workspaces } from './schema'

/**
 * Linearize workspace management authority with its mutation/event transaction.
 * The workspace lock fences lifecycle and precedes domain locks; the membership
 * SHARE lock conflicts with both DELETE and non-key role UPDATE. Revocation
 * committed first is observed; authorization locked first holds revocation
 * until the effect commits or rolls back. KEY SHARE would not fence role changes.
 */
export function withWorkspaceManagementAuthority<T>(
  database: AgentHqDatabase,
  input: Readonly<{
    includeArchived?: boolean
    permission: WorkspacePermission
    principal: UserPrincipalRef
    workspaceId: string
  }>,
  execute: (transaction: AgentHqTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(async (transaction) => {
    const [workspace] = await transaction
      .select({
        deletedAt: workspaces.deletedAt,
        deletionRequestedAt: workspaces.deletionRequestedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .for('update')
      .limit(1)
    if (
      !workspace ||
      workspace.deletionRequestedAt ||
      (!input.includeArchived && workspace.deletedAt)
    )
      throw new Error('Workspace unavailable')
    const [membership] = await transaction
      .select({ role: workspaceMemberships.role })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          eq(workspaceMemberships.userId, input.principal.userId)
        )
      )
      .for('share')
      .limit(1)
    if (
      !membership ||
      !new Set<WorkspacePermission>(workspaceRolePermissions[membership.role]).has(input.permission)
    )
      throw new Error('Workspace unavailable')
    // The executor receives this transaction, never a fresh database handle.
    // Its existing transaction wrapper creates a savepoint on this connection.
    return execute(transaction)
  })
}
