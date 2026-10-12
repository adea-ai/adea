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
  archiveWorkspace,
  archiveProject,
  channels,
  createProject,
  lockWorkspaceEventSequence,
  promoteProjectState,
  projectMembers,
  projects,
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
import { and, asc, eq, inArray } from 'drizzle-orm'

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
import {
  createManagementGateway,
  type ManagementAuthorizationInput,
  type ManagementCaller,
  type ManagementEffectAssertion,
} from './management-gateway'
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
  /** Test seam only; production binds the application database and authorizer. */
  database?: () => AgentHqDatabase
  authorize?: (input: ManagementAuthorizationInput) => Promise<boolean>
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
  const getDatabase = composition.database ?? applicationDatabase
  const authorize =
    composition.authorize ??
    (async (input: ManagementAuthorizationInput) => {
      const decision = await authorizeWorkspace(
        input.principal,
        input.permission,
        input.workspaceId,
        input.includeArchived ? { includeArchived: true } : {}
      )
      return decision.allowed
    })
  const gateway = createManagementGateway(
    {
      ...(composition.assertCurrent ? { assertCurrent: composition.assertCurrent } : {}),
      authorize,
      async audit(record) {
        if (record.caller.kind !== 'lead') return
        // The user-principal decision is audited by `authorizeWorkspace`; this
        // second existing audit row attributes the inherited lead action to the
        // exact lead Agent, turn and consumed approval without granting it anything.
        await recordWorkspaceAuthorizationDecision(getDatabase(), {
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
    database: getDatabase,
    executors: {
      archiveWorkspace: (database, workspaceId, principal, assertEffectCurrent) =>
        executeAuthorized(
          database,
          'config.workspace.archive',
          workspaceId,
          principal,
          (transaction) => archiveWorkspace(transaction, workspaceId, principal),
          assertEffectCurrent
        ),
      archiveProject: (database, workspaceId, projectId, principal, assertEffectCurrent) =>
        executeAuthorized(
          database,
          'project.archive',
          workspaceId,
          principal,
          (transaction) => archiveProject(transaction, workspaceId, projectId, principal),
          assertEffectCurrent,
          { projectIds: [projectId], projectChannels: 'active' }
        ),
      createProject: (database, workspaceId, principal, input, assertEffectCurrent) =>
        executeAuthorized(
          database,
          'project.create',
          workspaceId,
          principal,
          (transaction) => createProject(transaction, workspaceId, principal, input),
          assertEffectCurrent,
          { projectIds: input.id ? [input.id] : [] }
        ),
      promoteProjectState: (
        database,
        workspaceId,
        projectId,
        principal,
        input,
        assertEffectCurrent
      ) =>
        executeAuthorized(
          database,
          'project.promote',
          workspaceId,
          principal,
          (transaction) =>
            promoteProjectState(transaction, workspaceId, projectId, principal, input),
          assertEffectCurrent,
          { projectIds: [projectId], projectChannels: 'project-cascade-archived' }
        ),
      removeProjectMember: (
        database,
        workspaceId,
        projectId,
        principal,
        userId,
        assertEffectCurrent
      ) =>
        executeAuthorized(
          database,
          'project.member.remove',
          workspaceId,
          principal,
          (transaction) =>
            removeProjectMember(transaction, workspaceId, projectId, principal, userId),
          assertEffectCurrent,
          { projectIds: [projectId], projectMemberUserId: userId }
        ),
      reopenWorkspace: (database, workspaceId, principal, assertEffectCurrent) =>
        executeAuthorized(
          database,
          'config.workspace.reopen',
          workspaceId,
          principal,
          (transaction) => reopenWorkspace(transaction, workspaceId, principal),
          assertEffectCurrent
        ),
      reorderProjects: (database, workspaceId, principal, projectIds, assertEffectCurrent) =>
        executeAuthorized(
          database,
          'project.reorder',
          workspaceId,
          principal,
          (transaction) => reorderProjects(transaction, workspaceId, principal, projectIds),
          assertEffectCurrent,
          { projectIds }
        ),
      setProjectMember: (database, workspaceId, projectId, principal, input, assertEffectCurrent) =>
        executeAuthorized(
          database,
          'project.member.set',
          workspaceId,
          principal,
          (transaction) => setProjectMember(transaction, workspaceId, projectId, principal, input),
          assertEffectCurrent,
          { projectIds: [projectId], projectMemberUserId: input.userId }
        ),
      setProjectVisibility: (
        database,
        workspaceId,
        projectId,
        principal,
        visibility,
        assertEffectCurrent
      ) =>
        executeAuthorized(
          database,
          'project.visibility.set',
          workspaceId,
          principal,
          (transaction) =>
            setProjectVisibility(transaction, workspaceId, projectId, principal, visibility),
          assertEffectCurrent,
          { projectIds: [projectId] }
        ),
      softDeleteProject: (database, workspaceId, projectId, principal, assertEffectCurrent) =>
        executeAuthorized(
          database,
          'project.delete',
          workspaceId,
          principal,
          (transaction) => softDeleteProject(transaction, workspaceId, projectId, principal),
          assertEffectCurrent,
          { projectIds: [projectId], projectChannels: 'active' }
        ),
      updateProject: (database, workspaceId, projectId, principal, input, assertEffectCurrent) =>
        executeAuthorized(
          database,
          'project.update',
          workspaceId,
          principal,
          (transaction) => updateProject(transaction, workspaceId, projectId, principal, input),
          assertEffectCurrent,
          { projectIds: [projectId] }
        ),
      updateWorkspace: (database, workspaceId, principal, input, assertEffectCurrent) =>
        executeAuthorized(
          database,
          'config.workspace.update',
          workspaceId,
          principal,
          (transaction) => updateWorkspace(transaction, workspaceId, principal, input),
          assertEffectCurrent
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
  execute: (transaction: AgentHqTransaction) => Promise<T>,
  assertEffectCurrent: ManagementEffectAssertion,
  locks: ManagementEffectLocks = {}
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
    async (transaction) => {
      await lockManagementEffectRows(transaction, workspaceId, locks)
      await assertEffectCurrent()
      return execute(transaction)
    }
  )
}

type ManagementEffectLocks = Readonly<{
  projectChannels?: 'active' | 'project-cascade-archived'
  projectIds?: readonly string[]
  projectMemberUserId?: string
}>

/**
 * Acquire the rows the domain operation may write before asking CP whether
 * its single-use decision is still current. Keep the project→channel order
 * shared by the existing state-transition APIs.
 *
 * This closes local lock-wait gaps, but it cannot make CP revocation and the
 * Postgres commit atomic: CP may revoke immediately after its successful
 * response and before this transaction commits. A stronger guarantee needs a
 * CP-held lease or a commit fence spanning the local transaction.
 */
async function lockManagementEffectRows(
  transaction: AgentHqTransaction,
  workspaceId: string,
  locks: ManagementEffectLocks
): Promise<void> {
  const projectIds = [...new Set(locks.projectIds ?? [])].toSorted()
  if (projectIds.length) {
    await transaction
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, projectIds)))
      .orderBy(asc(projects.id))
      .for('update')
  }
  if (locks.projectChannels && projectIds.length) {
    for (const projectId of projectIds) {
      await transaction
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, workspaceId),
            eq(channels.projectId, projectId),
            locks.projectChannels === 'active'
              ? eq(channels.lifecycleState, 'active')
              : and(
                  eq(channels.lifecycleState, 'archived'),
                  eq(channels.archiveSource, 'project_cascade')
                )
          )
        )
        .orderBy(asc(channels.id))
        .for('update')
    }
  }
  if (locks.projectMemberUserId && projectIds.length) {
    await transaction
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.workspaceId, workspaceId),
          inArray(projectMembers.projectId, projectIds),
          eq(projectMembers.userId, locks.projectMemberUserId)
        )
      )
      .orderBy(asc(projectMembers.projectId), asc(projectMembers.userId))
      .for('update')
  }
  // Keep the domain lock order (project → channel → event sequence). The
  // archive/promote cascades append one event per channel, so acquire their
  // shared sequence row before asking CP whether its one-use decision remains
  // current; no event append can then wait after that authority check.
  await lockWorkspaceEventSequence(transaction, workspaceId)
}
