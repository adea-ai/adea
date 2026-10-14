/**
 * Shared management operation executors (M14.03.1, adea-ai/adea#1215).
 *
 * Every cloud management operation below runs through the shared gateway
 * (`management-gateway.ts`), which applies the inventory's lane support,
 * exact-call authority binding, authorization, revision/confirmation and audit
 * contract to the exact existing database API. HTTP routes and lead tools both
 * call these functions, so a management action cannot take a second,
 * unaudited path.
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
import type { ManagementCallBinding, ManagementOperationId } from '@adea-ai/types/management'

import type {
  ManagementEffectAssertion,
  ManagementGateway,
  ManagementOutcome,
} from './management-gateway'

export type ManagementExecutors = Readonly<{
  archiveProject(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<void>
  archiveWorkspace(
    database: AgentHqDatabase,
    workspaceId: string,
    principal: UserPrincipalRef,
    assertEffectCurrent: ManagementEffectAssertion
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
    }>,
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<ProjectSummary>
  promoteProjectState(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    input: Readonly<{ confirmed: boolean; expectedVersion: number }>,
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<ProjectSummary>
  removeProjectMember(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    userId: string,
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<boolean>
  reopenWorkspace(
    database: AgentHqDatabase,
    workspaceId: string,
    principal: UserPrincipalRef,
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<WorkspaceSummary>
  reorderProjects(
    database: AgentHqDatabase,
    workspaceId: string,
    principal: UserPrincipalRef,
    projectIds: readonly string[],
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<readonly ProjectSummary[]>
  setProjectMember(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    input: Readonly<{ role: ProjectMemberRole; userId: string }>,
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<ProjectMemberSummary>
  setProjectVisibility(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    visibility: ProjectVisibility,
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<ProjectSummary>
  softDeleteProject(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<void>
  updateProject(
    database: AgentHqDatabase,
    workspaceId: string,
    projectId: string,
    principal: UserPrincipalRef,
    input: Readonly<{ iconKey?: string; name?: string; sourceKind?: ProjectSourceKind }>,
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<ProjectSummary>
  updateWorkspace(
    database: AgentHqDatabase,
    workspaceId: string,
    principal: UserPrincipalRef,
    input: Readonly<{ expectedVersion: number; update: WorkspaceUpdate }>,
    assertEffectCurrent: ManagementEffectAssertion
  ): Promise<WorkspaceSummary>
}>

/**
 * A lead caller must pass the exact-call binding its decision was issued for;
 * a human caller omits it. The gateway refuses a lead invocation without it.
 */
export type ManagementBindingArgument = ManagementCallBinding | undefined

export type ManagementOperations = Readonly<{
  projectArchive(
    input: Readonly<{ principal: UserPrincipalRef; projectId: string; workspaceId: string }>,
    binding?: ManagementBindingArgument
  ): Promise<ManagementOutcome<null>>
  projectCreate(
    input: Readonly<{
      iconKey: string
      id?: string
      name: string
      principal: UserPrincipalRef
      sourceKind?: ProjectSourceKind
      workspaceId: string
    }>,
    binding?: ManagementBindingArgument
  ): Promise<ManagementOutcome<ProjectSummary>>
  projectDelete(
    input: Readonly<{ principal: UserPrincipalRef; projectId: string; workspaceId: string }>,
    binding?: ManagementBindingArgument
  ): Promise<ManagementOutcome<null>>
  projectPromote(
    input: Readonly<{
      confirmed: boolean
      expectedVersion: number
      principal: UserPrincipalRef
      projectId: string
      workspaceId: string
    }>,
    binding: ManagementBindingArgument
  ): Promise<ManagementOutcome<ProjectSummary>>
  projectMemberRemove(
    input: Readonly<{
      principal: UserPrincipalRef
      projectId: string
      userId: string
      workspaceId: string
    }>,
    binding?: ManagementBindingArgument
  ): Promise<ManagementOutcome<boolean>>
  projectMemberSet(
    input: Readonly<{
      principal: UserPrincipalRef
      projectId: string
      role: ProjectMemberRole
      userId: string
      workspaceId: string
    }>,
    binding?: ManagementBindingArgument
  ): Promise<ManagementOutcome<ProjectMemberSummary>>
  projectReorder(
    input: Readonly<{
      principal: UserPrincipalRef
      projectIds: readonly string[]
      workspaceId: string
    }>,
    binding?: ManagementBindingArgument
  ): Promise<ManagementOutcome<readonly ProjectSummary[]>>
  projectUpdate(
    input: Readonly<{
      iconKey?: string
      name?: string
      principal: UserPrincipalRef
      projectId: string
      sourceKind?: ProjectSourceKind
      workspaceId: string
    }>,
    binding?: ManagementBindingArgument
  ): Promise<ManagementOutcome<ProjectSummary>>
  projectVisibilitySet(
    input: Readonly<{
      principal: UserPrincipalRef
      projectId: string
      visibility: ProjectVisibility
      workspaceId: string
    }>,
    binding?: ManagementBindingArgument
  ): Promise<ManagementOutcome<ProjectSummary>>
  workspaceReopen(
    input: Readonly<{ principal: UserPrincipalRef; workspaceId: string }>,
    binding?: ManagementBindingArgument
  ): Promise<ManagementOutcome<WorkspaceSummary>>
  workspaceArchive(
    input: Readonly<{ confirmed: boolean; principal: UserPrincipalRef; workspaceId: string }>,
    binding?: ManagementBindingArgument
  ): Promise<ManagementOutcome<null>>
  workspaceUpdate(
    input: Readonly<{
      expectedVersion: number
      principal: UserPrincipalRef
      update: WorkspaceUpdate
      workspaceId: string
    }>,
    binding?: ManagementBindingArgument
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
  binding: ManagementBindingArgument,
  execute: (assertEffectCurrent: ManagementEffectAssertion) => Promise<T>
) {
  return gateway.run(operation, binding ? { ...input, binding } : input, execute)
}

export function createManagementOperations(
  options: ManagementOperationsOptions
): ManagementOperations {
  const { database, executors, gateway } = options
  return Object.freeze({
    projectArchive: (input, binding) =>
      run(
        gateway,
        'project.archive',
        input,
        binding,
        async (assertEffectCurrent) =>
          (await executors.archiveProject(
            database(),
            input.workspaceId,
            input.projectId,
            input.principal,
            assertEffectCurrent
          )) ?? null
      ),
    projectCreate: (input, binding) =>
      run(gateway, 'project.create', input, binding, (assertEffectCurrent) =>
        executors.createProject(
          database(),
          input.workspaceId,
          input.principal,
          {
            iconKey: input.iconKey,
            ...(input.id ? { id: input.id } : {}),
            name: input.name,
            ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
          },
          assertEffectCurrent
        )
      ),
    projectDelete: (input, binding) =>
      run(
        gateway,
        'project.delete',
        input,
        binding,
        async (assertEffectCurrent) =>
          (await executors.softDeleteProject(
            database(),
            input.workspaceId,
            input.projectId,
            input.principal,
            assertEffectCurrent
          )) ?? null
      ),
    projectMemberRemove: (input, binding) =>
      run(gateway, 'project.member.remove', input, binding, (assertEffectCurrent) =>
        executors.removeProjectMember(
          database(),
          input.workspaceId,
          input.projectId,
          input.principal,
          input.userId,
          assertEffectCurrent
        )
      ),
    projectMemberSet: (input, binding) =>
      run(gateway, 'project.member.set', input, binding, (assertEffectCurrent) =>
        executors.setProjectMember(
          database(),
          input.workspaceId,
          input.projectId,
          input.principal,
          {
            role: input.role,
            userId: input.userId,
          },
          assertEffectCurrent
        )
      ),
    projectPromote: (input, binding) =>
      run(gateway, 'project.promote', input, binding, (assertEffectCurrent) =>
        executors.promoteProjectState(
          database(),
          input.workspaceId,
          input.projectId,
          input.principal,
          { confirmed: input.confirmed, expectedVersion: input.expectedVersion },
          assertEffectCurrent
        )
      ),
    projectReorder: (input, binding) =>
      run(gateway, 'project.reorder', input, binding, (assertEffectCurrent) =>
        executors.reorderProjects(
          database(),
          input.workspaceId,
          input.principal,
          input.projectIds,
          assertEffectCurrent
        )
      ),
    projectUpdate: (input, binding) =>
      run(gateway, 'project.update', input, binding, (assertEffectCurrent) =>
        executors.updateProject(
          database(),
          input.workspaceId,
          input.projectId,
          input.principal,
          {
            ...(input.iconKey !== undefined ? { iconKey: input.iconKey } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.sourceKind !== undefined ? { sourceKind: input.sourceKind } : {}),
          },
          assertEffectCurrent
        )
      ),
    projectVisibilitySet: (input, binding) =>
      run(gateway, 'project.visibility.set', input, binding, (assertEffectCurrent) =>
        executors.setProjectVisibility(
          database(),
          input.workspaceId,
          input.projectId,
          input.principal,
          input.visibility,
          assertEffectCurrent
        )
      ),
    workspaceReopen: (input, binding) =>
      run(
        gateway,
        'config.workspace.reopen',
        { ...input, includeArchived: true },
        binding,
        (assertEffectCurrent) =>
          executors.reopenWorkspace(
            database(),
            input.workspaceId,
            input.principal,
            assertEffectCurrent
          )
      ),
    workspaceArchive: (input, binding) =>
      input.confirmed !== true
        ? Promise.resolve({
            failure: {
              code: 'conflict' as const,
              message: 'Management target requires explicit confirmation',
              operation: 'config.workspace.archive' as const,
            },
            ok: false as const,
          })
        : run(gateway, 'config.workspace.archive', input, binding, async (assertEffectCurrent) => {
            await executors.archiveWorkspace(
              database(),
              input.workspaceId,
              input.principal,
              assertEffectCurrent
            )
            return null
          }),
    workspaceUpdate: (input, binding) =>
      run(gateway, 'config.workspace.update', input, binding, (assertEffectCurrent) =>
        executors.updateWorkspace(
          database(),
          input.workspaceId,
          input.principal,
          {
            expectedVersion: input.expectedVersion,
            update: input.update,
          },
          assertEffectCurrent
        )
      ),
  })
}
