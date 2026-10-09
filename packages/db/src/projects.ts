import type { ProjectSourceKind, ProjectSummary, UserPrincipalRef } from '@adea-ai/types'
import { and, asc, eq, inArray, isNull, max } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { mintControlPlaneIdentifier } from './control-plane-identifiers'
import { provisionPrimaryProjectChannelInTransaction } from './conversations'
import {
  canReadProject,
  requireProjectAccessScope,
  requireProjectWrite,
  resolveProjectAccessScope,
  visibleProjectCondition,
} from './project-access'
import { archiveProjectChannels, lockProjectForStateChange } from './project-state-policy'
import { projects, workspaceMemberships } from './schema'
import { appendWorkspaceEvent } from './transactions'

type ProjectCreateInput = Readonly<{
  iconKey: string
  /**
   * Optional client-supplied id. Replaying a create with the same id and the
   * same fields returns the existing project instead of creating another one,
   * so offline or retried creates are idempotent.
   */
  id?: string
  name: string
  sourceKind?: ProjectSourceKind
}>

type ProjectUpdateInput = Readonly<{
  iconKey?: string
  name?: string
  sourceKind?: ProjectSourceKind
}>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isProjectSourceKind(value: unknown): value is ProjectSourceKind {
  return value === 'none' || value === 'repository'
}

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function projectSummary(row: typeof projects.$inferSelect): ProjectSummary {
  return Object.freeze({
    createdAt: row.createdAt.toISOString(),
    iconKey: row.iconKey,
    id: row.id,
    lifecycleState: row.lifecycleState,
    name: row.name,
    sortOrder: row.sortOrder,
    sourceKind: row.sourceKind,
    updatedAt: row.updatedAt.toISOString(),
    visibility: row.visibility,
    workspaceId: row.workspaceId,
  })
}

async function requireMembership(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<void> {
  const [membership] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!membership) throw new Error('Project unavailable')
}

/** Active, non-deleted projects of one workspace. */
function activeProjectFilter(workspaceId: string, projectId?: string) {
  return and(
    ...(projectId ? [eq(projects.id, projectId)] : []),
    eq(projects.workspaceId, workspaceId),
    eq(projects.lifecycleState, 'active'),
    isNull(projects.deletedAt)
  )
}

export async function createProject(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: ProjectCreateInput
): Promise<ProjectSummary> {
  if (input.id !== undefined && !isProjectId(input.id)) throw new Error('Project id invalid')
  const name = input.name.trim()
  const iconKey = input.iconKey.trim()
  const sourceKind = input.sourceKind ?? 'none'
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    if (input.id) {
      const [existing] = await transaction
        .select()
        .from(projects)
        .where(eq(projects.id, input.id))
        .limit(1)
      if (existing) {
        // Never reveal that an id is taken in another workspace.
        if (existing.workspaceId !== workspaceId || existing.deletedAt) {
          throw new Error('Project unavailable')
        }
        if (
          existing.name !== name ||
          existing.iconKey !== iconKey ||
          existing.sourceKind !== sourceKind
        ) {
          throw new Error('Project id conflict')
        }
        return projectSummary(existing)
      }
    }
    const [position] = await transaction
      .select({ value: max(projects.sortOrder) })
      .from(projects)
      .where(activeProjectFilter(workspaceId))
    const [created] = await transaction
      .insert(projects)
      .values({
        ...(input.id ? { id: input.id } : {}),
        controlPlaneProjectId: mintControlPlaneIdentifier('prj'),
        iconKey,
        name,
        sortOrder: (position?.value ?? -1) + 1,
        sourceKind,
        workspaceId,
      })
      .returning()
    if (!created) throw new Error('Project creation failed')
    await provisionPrimaryProjectChannelInTransaction(
      transaction,
      workspaceId,
      created.id,
      created.name
    )
    await appendWorkspaceEvent(transaction, {
      eventType: 'project.created',
      payload: { actorUserId: principal.userId, projectId: created.id },
      workspaceId,
    })
    return projectSummary(created)
  })
}

export async function listProjectsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<ProjectSummary[]> {
  const scope = await requireProjectAccessScope(
    database,
    workspaceId,
    principal,
    'Project unavailable'
  )
  const rows = await database
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        isNull(projects.deletedAt),
        visibleProjectCondition(projects.id, scope),
        ...(options.includeArchived ? [] : [eq(projects.lifecycleState, 'active')])
      )
    )
    .orderBy(asc(projects.sortOrder), asc(projects.id))
  return rows.map(projectSummary)
}

export async function getProjectForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<ProjectSummary | null> {
  if (!isProjectId(projectId)) return null
  const scope = await resolveProjectAccessScope(database, workspaceId, principal.userId)
  if (!scope || !canReadProject(scope, projectId)) return null
  const [row] = await database
    .select({ project: projects })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.workspaceId, workspaceId),
        isNull(projects.deletedAt),
        ...(options.includeArchived ? [] : [eq(projects.lifecycleState, 'active')])
      )
    )
    .limit(1)
  return row ? projectSummary(row.project) : null
}

export async function updateProject(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef,
  input: ProjectUpdateInput
): Promise<ProjectSummary> {
  if (!isProjectId(projectId)) throw new Error('Project unavailable')
  return database.transaction(async (transaction) => {
    const scope = await requireProjectAccessScope(
      transaction,
      workspaceId,
      principal,
      'Project unavailable'
    )
    requireProjectWrite(scope, projectId, 'Project unavailable')
    const [updated] = await transaction
      .update(projects)
      .set({
        ...(input.iconKey !== undefined ? { iconKey: input.iconKey.trim() } : {}),
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.sourceKind !== undefined ? { sourceKind: input.sourceKind } : {}),
        updatedAt: new Date(),
      })
      .where(activeProjectFilter(workspaceId, projectId))
      .returning()
    if (!updated) throw new Error('Project unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'project.updated',
      payload: { actorUserId: principal.userId, projectId },
      workspaceId,
    })
    return projectSummary(updated)
  })
}

export async function archiveProject(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef
): Promise<void> {
  if (!isProjectId(projectId)) throw new Error('Project unavailable')
  await database.transaction(async (transaction) => {
    const scope = await requireProjectAccessScope(
      transaction,
      workspaceId,
      principal,
      'Project unavailable'
    )
    requireProjectWrite(scope, projectId, 'Project unavailable')
    // Project lock first, then channels in id order (the canonical order
    // shared with soft delete and promotion).
    await lockProjectForStateChange(transaction, workspaceId, projectId)
    await archiveProjectChannels(transaction, workspaceId, projectId, principal)
    const [archived] = await transaction
      .update(projects)
      .set({ lifecycleState: 'archived', updatedAt: new Date() })
      .where(activeProjectFilter(workspaceId, projectId))
      .returning({ id: projects.id })
    if (!archived) throw new Error('Project unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'project.archived',
      payload: { actorUserId: principal.userId, projectId },
      workspaceId,
    })
  })
}

/**
 * Soft-delete an active or archived project. The row is kept (tasks, agents
 * and channel history still reference it) but it leaves every listing and can
 * no longer be read, updated, reordered or recreated under the same id.
 */
export async function softDeleteProject(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef
): Promise<void> {
  if (!isProjectId(projectId)) throw new Error('Project unavailable')
  await database.transaction(async (transaction) => {
    const scope = await requireProjectAccessScope(
      transaction,
      workspaceId,
      principal,
      'Project unavailable'
    )
    requireProjectWrite(scope, projectId, 'Project unavailable')
    // Same canonical order as archive: project row, then its channels.
    await lockProjectForStateChange(transaction, workspaceId, projectId)
    await archiveProjectChannels(transaction, workspaceId, projectId, principal)
    const now = new Date()
    const [deleted] = await transaction
      .update(projects)
      .set({ deletedAt: now, lifecycleState: 'archived', updatedAt: now })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.workspaceId, workspaceId),
          isNull(projects.deletedAt)
        )
      )
      .returning({ id: projects.id })
    if (!deleted) throw new Error('Project unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'project.deleted',
      payload: { actorUserId: principal.userId, projectId },
      workspaceId,
    })
  })
}

export async function reorderProjects(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  projectIds: readonly string[]
): Promise<ProjectSummary[]> {
  return database.transaction(async (transaction) => {
    const scope = await requireProjectAccessScope(
      transaction,
      workspaceId,
      principal,
      'Project unavailable'
    )
    // A principal orders the projects they can see. Hidden projects keep their
    // positions: the visible ones are permuted across the slots they already
    // occupy, so a reorder can neither reveal nor displace a hidden project.
    const activeProjects = await transaction
      .select()
      .from(projects)
      .where(and(activeProjectFilter(workspaceId), visibleProjectCondition(projects.id, scope)))
      .orderBy(asc(projects.sortOrder), asc(projects.id))
    if (
      projectIds.length !== activeProjects.length ||
      new Set(projectIds).size !== projectIds.length ||
      activeProjects.some(({ id }) => !projectIds.includes(id))
    ) {
      throw new Error('Project order conflict')
    }
    const slots = scope.hiddenProjectIds.length
      ? activeProjects.map((project) => project.sortOrder)
      : projectIds.map((_, index) => index)
    for (const [index, projectId] of projectIds.entries()) {
      await transaction
        .update(projects)
        .set({ sortOrder: slots[index]!, updatedAt: new Date() })
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    }
    await appendWorkspaceEvent(transaction, {
      eventType: 'project.reordered',
      payload: { actorUserId: principal.userId, projectIds: [...projectIds] },
      workspaceId,
    })
    const reordered = await transaction
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, [...projectIds])))
      .orderBy(asc(projects.sortOrder), asc(projects.id))
    return reordered.map(projectSummary)
  })
}
