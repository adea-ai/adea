/**
 * Shared management operation executors (M14.03.1, adea-ai/adea#1215).
 *
 * Every cloud management operation below runs through the shared gateway
 * (`management-gateway.ts`), which applies the inventory's lane support,
 * authorization, revision/confirmation and audit contract to the exact
 * existing database API. HTTP routes and lead tools both call these functions,
 * so a management action cannot take a second, unaudited path.
 *
 * The executor map is injected: the composition module wires the real
 * `@adea-ai/db` functions, while focused tests substitute fakes without a
 * database. No `server-only` marker: Bun-run unit tests import this module.
 */
import type { AgentHqDatabase } from '@adea-ai/db'
import type {
  ProjectMemberRole,
  ProjectMemberSummary,
  ProjectSourceKind,
  ProjectSummary,
  ProjectVisibility,
  UserPrincipalRef,
  WorkspaceSummary,
  WorkspaceUpdate,
} from '@adea-ai/types'
import type { ManagementOperationId } from '@adea-ai/types/management'

import type { ManagementGateway, ManagementOutcome } from './management-gateway'

export type ManagementExecutors = Readonly<{
  archiveProject(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef
  ): Promise<void>
  createProject(
    database: AgentHqDatabase,
    workspaceId: string,
    principal: UserPrincipalRef,
    input: Readonly<{
      iconKey: string
      id?: string
      name: string
      sourceKind?: ProjectSourceKind
    }>
  ): Promise<ProjectSummary>
  promoteProjectState(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    input: Readonly<{ confirmed: boolean; expectedVersion: number }>
  ): Promise<ProjectSummary>
  removeProjectMember(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    userId: string
  ): Promise<boolean>
  reopenWorkspace(
    database: AgentHqDatabase,
    workspaceId: string,
    principal: UserPrincipalRef
  ): Promise<WorkspaceSummary>
  reorderProjects(
    database: AgentHqDatabase,
    workspaceId: string,
    principal: UserPrincipalRef,
    projectIds: readonly string[]
  ): Promise<readonly ProjectSummary[]>
  setProjectMember(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    input: Readonly<{ role: ProjectMemberRole; userId: string }>
  ): Promise<ProjectMemberSummary>
  setProjectVisibility(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    visibility: ProjectVisibility
  ): Promise<ProjectSummary>
  softDeleteProject(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef
  ): Promise<void>
  updateProject(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    input: Readonly<{ iconKey?: string; name?: string; sourceKind?: ProjectSourceKind }>
  ): Promise<ProjectSummary>
  updateWorkspace(
    database: AgentHqDatabase,
    workspaceId: string,
    principal: UserPrincipalRef,
    input: Readonly<{ expectedVersion: number; update: WorkspaceUpdate }>
  ): Promise<WorkspaceSummary>
}>

export type ManagementOperations = Readonly<{
  projectArchive(
    input: Readonly<{ principal: UserPrincipalRef; projectId: string; workspaceId: string }>
  ): Promise<ManagementOutcome<null>>
  projectCreate(
    input: Readonly<{
      iconKey: string
      id?: string
      name: string
      principal: UserPrincipalRef
      sourceKind?: ProjectSourceKind
      workspaceId: string
    }>
  ): Promise<ManagementOutcome<ProjectSummary>>
  projectDelete(
    input: Readonly<{ principal: UserPrincipalRef; projectId: string; workspaceId: string }>
  ): Promise<ManagementOutcome<null>>
  projectPromote(
    input: Readonly<{
      confirmed: boolean
      expectedVersion: number
      principal: UserPrincipalRef
      projectId: string
      workspaceId: string
    }>
  ): Promise<ManagementOutcome<ProjectSummary>>
  projectMemberRemove(
    input: Readonly<{
      principal: UserPrincipalRef
      projectId: string
      userId: string
      workspaceId: string
    }>
  ): Promise<ManagementOutcome<boolean>>
  projectMemberSet(
    input: Readonly<{
      principal: UserPrincipalRef
      projectId: string
      role: ProjectMemberRole
      userId: string
      workspaceId: string
    }>
  ): Promise<ManagementOutcome<ProjectMemberSummary>>
  projectReorder(
    input: Readonly<{
      principal: UserPrincipalRef
      projectIds: readonly string[]
      workspaceId: string
    }>
  ): Promise<ManagementOutcome<readonly ProjectSummary[]>>
  projectUpdate(
    input: Readonly<{
      iconKey?: string
      name?: string
      principal: UserPrincipalRef
      projectId: string
      sourceKind?: ProjectSourceKind
      workspaceId: string
    }>
  ): Promise<ManagementOutcome<ProjectSummary>>
  projectVisibilitySet(
    input: Readonly<{
      principal: UserPrincipalRef
      projectId: string
      visibility: ProjectVisibility
      workspaceId: string
    }>
  ): Promise<ManagementOutcome<ProjectSummary>>
  workspaceReopen(
    input: Readonly<{ principal: UserPrincipalRef; workspaceId: string }>
  ): Promise<ManagementOutcome<WorkspaceSummary>>
  workspaceUpdate(
    input: Readonly<{
      expectedVersion: number
      principal: UserPrincipalRef
      update: WorkspaceUpdate
      workspaceId: string
    }>
  ): Promise<ManagementOutcome<WorkspaceSummary>>
}>

export type ManagementOperationsOptions = Readonly<{
  database(): AgentHqDatabase
  executors: ManagementExecutors
  gateway: ManagementGateway
}>

function run<T>(
  gateway: ManagementGateway,
  operation: ManagementOperationId,
  input: Readonly<{ includeArchived?: boolean; principal: UserPrincipalRef; workspaceId: string }>,
  execute: () => Promise<T>
) {
  return gateway.run(operation, input, execute)
}

export function createManagementOperations(
  options: ManagementOperationsOptions
): ManagementOperations {
  const { database, executors, gateway } = options
  return Object.freeze({
    projectArchive: (input) =>
      run(
        gateway,
        'project.archive',
        input,
        async () =>
          (await executors.archiveProject(
            database(),
            input.workspaceId,
            input.projectId,
            input.principal
          )) ?? null
      ),
    projectCreate: (input) =>
      run(gateway, 'project.create', input, () =>
        executors.createProject(database(), input.workspaceId, input.principal, {
          iconKey: input.iconKey,
          ...(input.id ? { id: input.id } : {}),
          name: input.name,
          ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
        })
      ),
    projectDelete: (input) =>
      run(
        gateway,
        'project.delete',
        input,
        async () =>
          (await executors.softDeleteProject(
            database(),
            input.workspaceId,
            input.projectId,
            input.principal
          )) ?? null
      ),
    projectMemberRemove: (input) =>
      run(gateway, 'project.member.remove', input, () =>
        executors.removeProjectMember(
          database(),
          input.workspaceId,
          input.projectId,
          input.principal,
          input.userId
        )
      ),
    projectMemberSet: (input) =>
      run(gateway, 'project.member.set', input, () =>
        executors.setProjectMember(
          database(),
          input.workspaceId,
          input.projectId,
          input.principal,
          {
            role: input.role,
            userId: input.userId,
          }
        )
      ),
    projectPromote: (input) =>
      run(gateway, 'project.promote', input, () =>
        executors.promoteProjectState(
          database(),
          input.workspaceId,
          input.projectId,
          input.principal,
          { confirmed: input.confirmed, expectedVersion: input.expectedVersion }
        )
      ),
    projectReorder: (input) =>
      run(gateway, 'project.reorder', input, () =>
        executors.reorderProjects(database(), input.workspaceId, input.principal, input.projectIds)
      ),
    projectUpdate: (input) =>
      run(gateway, 'project.update', input, () =>
        executors.updateProject(database(), input.workspaceId, input.projectId, input.principal, {
          ...(input.iconKey !== undefined ? { iconKey: input.iconKey } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.sourceKind !== undefined ? { sourceKind: input.sourceKind } : {}),
        })
      ),
    projectVisibilitySet: (input) =>
      run(gateway, 'project.visibility.set', input, () =>
        executors.setProjectVisibility(
          database(),
          input.workspaceId,
          input.projectId,
          input.principal,
          input.visibility
        )
      ),
    workspaceReopen: (input) =>
      run(gateway, 'config.workspace.reopen', { ...input, includeArchived: true }, () =>
        executors.reopenWorkspace(database(), input.workspaceId, input.principal)
      ),
    workspaceUpdate: (input) =>
      run(gateway, 'config.workspace.update', input, () =>
        executors.updateWorkspace(database(), input.workspaceId, input.principal, {
          expectedVersion: input.expectedVersion,
          update: input.update,
        })
      ),
  })
}
