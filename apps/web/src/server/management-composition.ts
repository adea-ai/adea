/**
 * Production composition for the shared management surface (M14.03.1,
 * adea-ai/adea#1215). Wires the inventory operation executors to the existing
 * `@adea-ai/db` functions and the shared authorization/audit APIs. HTTP routes
 * and the future lead tool host use the identical composition.
 *
 * `server-only`-clean: this module is only imported by server routes and the
 * lead tool host; unit tests inject the executor fakes instead.
 */
import {
  archiveProject,
  createProject,
  promoteProjectState,
  recordWorkspaceAuthorizationDecision,
  removeProjectMember,
  reopenWorkspace,
  reorderProjects,
  setProjectMember,
  setProjectVisibility,
  softDeleteProject,
  updateProject,
  updateWorkspace,
  withWorkspaceManagementAuthority,
  type AgentHqDatabase,
  type AgentHqTransaction,
} from '@adea-ai/db'

import type { UserPrincipalRef } from '@adea-ai/types'
import {
  managementOperations,
  type ManagementCurrentAuthority,
  type ManagementOperationId,
} from '@adea-ai/types/management'

import { scopedAdminCredential } from './control-plane-client'
import { controlPlaneScopeResolver } from './control-plane-scope'
import { applicationDatabase } from './database'
import { createControlPlaneManagementCurrentAuthority } from './management-authority-current'
import { createManagementGateway, type ManagementCaller } from './management-gateway'
import { createManagementOperations, type ManagementOperations } from './management-operations'
import { authorizeWorkspace } from './workspace-authorization'

export type ApplicationManagementComposition = Readonly<{
  /**
   * The host's canonical current-authority owner. The production CP host
   * mapping supplies it (control-plane PR #1038 assertCurrent); the route and
   * the gateway must receive the same instance.
   */
  assertCurrent?: ManagementCurrentAuthority
  /** Test seam only; production omits it and uses the wall clock. */
  now?: () => number
}>

/**
 * The real authenticated Control API hop for the canonical current authority
 * (PR #1038 helper exposed by the `feat/issue-932-management-current-authority`
 * route). It fails closed when the Control Plane origin/signing is unconfigured
 * or the request carries no canonical request from the CP host mapping.
 */
export function applicationManagementCurrentAuthority(): ManagementCurrentAuthority {
  return createControlPlaneManagementCurrentAuthority({
    credential: (request) =>
      scopedAdminCredential(['execution:read'], {
        resolveControlPlaneScope: controlPlaneScopeResolver(request.binding.workspaceId),
      }),
  })
}

export function applicationManagementOperations(
  caller: ManagementCaller = { kind: 'human' },
  composition: ApplicationManagementComposition = {}
): ManagementOperations {
  const gateway = createManagementGateway(
    {
      ...(composition.assertCurrent ? { assertCurrent: composition.assertCurrent } : {}),
      async authorize(input) {
        const decision = await authorizeWorkspace(
          input.principal,
          input.permission,
          input.workspaceId,
          input.includeArchived ? { includeArchived: true } : {}
        )
        return decision.allowed
      },
      async audit(record) {
        if (record.caller.kind !== 'lead') return
        // The user-principal decision is audited by `authorizeWorkspace`; this
        // second existing audit row attributes the inherited lead action to the
        // exact lead Agent, turn and consumed approval without granting it anything.
        await recordWorkspaceAuthorizationDecision(applicationDatabase(), {
          decision: record.decision,
          permission: record.permission,
          principal: { agentId: record.caller.decision.leadAgentId, kind: 'agent' },
          reason: `${record.reason}:${record.operation}:${record.caller.decision.intentId}:${record.decisionId ?? record.caller.decision.decisionId}`,
          workspaceId: record.workspaceId,
        })
      },
    },
    caller,
    composition.now
  )
  return createManagementOperations({
    database: applicationDatabase,
    executors: {
      archiveProject: (database, workspaceId, projectId, principal) =>
        executeAuthorized(database, 'project.archive', workspaceId, principal, (transaction) =>
          archiveProject(transaction, workspaceId, projectId, principal)
        ),
      createProject: (database, workspaceId, principal, input) =>
        executeAuthorized(database, 'project.create', workspaceId, principal, (transaction) =>
          createProject(transaction, workspaceId, principal, input)
        ),
      promoteProjectState: (database, workspaceId, projectId, principal, input) =>
        executeAuthorized(database, 'project.promote', workspaceId, principal, (transaction) =>
          promoteProjectState(transaction, workspaceId, projectId, principal, input)
        ),
      removeProjectMember: (database, workspaceId, projectId, principal, userId) =>
        executeAuthorized(
          database,
          'project.member.remove',
          workspaceId,
          principal,
          (transaction) =>
            removeProjectMember(transaction, workspaceId, projectId, principal, userId)
        ),
      reopenWorkspace: (database, workspaceId, principal) =>
        executeAuthorized(
          database,
          'config.workspace.reopen',
          workspaceId,
          principal,
          (transaction) => reopenWorkspace(transaction, workspaceId, principal)
        ),
      reorderProjects: (database, workspaceId, principal, projectIds) =>
        executeAuthorized(database, 'project.reorder', workspaceId, principal, (transaction) =>
          reorderProjects(transaction, workspaceId, principal, projectIds)
        ),
      setProjectMember: (database, workspaceId, projectId, principal, input) =>
        executeAuthorized(database, 'project.member.set', workspaceId, principal, (transaction) =>
          setProjectMember(transaction, workspaceId, projectId, principal, input)
        ),
      setProjectVisibility: (database, workspaceId, projectId, principal, visibility) =>
        executeAuthorized(
          database,
          'project.visibility.set',
          workspaceId,
          principal,
          (transaction) =>
            setProjectVisibility(transaction, workspaceId, projectId, principal, visibility)
        ),
      softDeleteProject: (database, workspaceId, projectId, principal) =>
        executeAuthorized(database, 'project.delete', workspaceId, principal, (transaction) =>
          softDeleteProject(transaction, workspaceId, projectId, principal)
        ),
      updateProject: (database, workspaceId, projectId, principal, input) =>
        executeAuthorized(database, 'project.update', workspaceId, principal, (transaction) =>
          updateProject(transaction, workspaceId, projectId, principal, input)
        ),
      updateWorkspace: (database, workspaceId, principal, input) =>
        executeAuthorized(
          database,
          'config.workspace.update',
          workspaceId,
          principal,
          (transaction) => updateWorkspace(transaction, workspaceId, principal, input)
        ),
    },
    gateway,
  })
}

function executeAuthorized<T>(
  database: AgentHqDatabase,
  operation: ManagementOperationId,
  workspaceId: string,
  principal: UserPrincipalRef,
  execute: (transaction: AgentHqTransaction) => Promise<T>
): Promise<T> {
  const permission = managementOperations[operation].permission
  if (!permission) throw new Error('Workspace unavailable')
  return withWorkspaceManagementAuthority(
    database,
    {
      ...(operation === 'config.workspace.reopen' ? { includeArchived: true } : {}),
      permission,
      principal,
      workspaceId,
    },
    execute
  )
}
