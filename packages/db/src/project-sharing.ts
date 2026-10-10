import type {
  ProjectMemberRole,
  ProjectMemberSummary,
  ProjectSummary,
  ProjectVisibility,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { canReadProject, requireProjectAccessScope } from './project-access'
import { projectSummary } from './project-summary'
import { projectMembers, projects, users, workspaceMemberships } from './schema'
import { appendWorkspaceEvent } from './transactions'

/**
 * Project sharing (ADR 0012): visibility and the project member list.
 *
 * Only workspace owners and admins change who can see a project. Anyone who
 * can see a project may read its member list, so the Share dialog renders for
 * viewers too.
 */

export function isProjectVisibility(value: unknown): value is ProjectVisibility {
  return value === 'workspace' || value === 'members'
}

export function isProjectMemberRole(value: unknown): value is ProjectMemberRole {
  return value === 'viewer' || value === 'editor'
}

const UNAVAILABLE = 'Project unavailable'

async function requireManager(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  const scope = await requireProjectAccessScope(database, workspaceId, principal, UNAVAILABLE)
  if (!scope.privileged) throw new Error('Project sharing forbidden')
  return scope
}

async function requireProjectRow(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  projectId: string
) {
  const [project] = await database
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.workspaceId, workspaceId),
        isNull(projects.deletedAt)
      )
    )
    .limit(1)
  if (!project) throw new Error(UNAVAILABLE)
  return project
}

export async function setProjectVisibility(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef,
  visibility: ProjectVisibility
): Promise<ProjectSummary> {
  return database.transaction(async (transaction) => {
    await requireManager(transaction, workspaceId, principal)
    const project = await requireProjectRow(transaction, workspaceId, projectId)
    const [updated] =
      project.visibility === visibility
        ? [project]
        : await transaction
            .update(projects)
            .set({
              updatedAt: new Date(),
              version: sql`${projects.version} + 1`,
              visibility,
            })
            .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
            .returning()
    if (!updated) throw new Error(UNAVAILABLE)
    if (project.visibility !== visibility) {
      await appendWorkspaceEvent(transaction, {
        eventType: 'project.visibility_changed',
        payload: { actorUserId: principal.userId, projectId, visibility },
        workspaceId,
      })
    }
    return projectSummary(updated)
  })
}

export async function listProjectMembersForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef
): Promise<readonly ProjectMemberSummary[]> {
  const scope = await requireProjectAccessScope(database, workspaceId, principal, UNAVAILABLE)
  if (!canReadProject(scope, projectId)) throw new Error(UNAVAILABLE)
  await requireProjectRow(database, workspaceId, projectId)
  const rows = await database
    .select({ displayName: users.displayName, member: projectMembers })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(eq(projectMembers.workspaceId, workspaceId), eq(projectMembers.projectId, projectId))
    )
    .orderBy(asc(projectMembers.createdAt), asc(projectMembers.userId))
  return Object.freeze(
    rows.map(({ displayName, member }) =>
      Object.freeze({
        createdAt: member.createdAt.toISOString(),
        displayName,
        projectId: member.projectId,
        role: member.role,
        updatedAt: member.updatedAt.toISOString(),
        userId: member.userId,
      })
    )
  )
}

/** Add a workspace member to a project, or change their role. */
export async function setProjectMember(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ role: ProjectMemberRole; userId: string }>
): Promise<ProjectMemberSummary> {
  return database.transaction(async (transaction) => {
    await requireManager(transaction, workspaceId, principal)
    await requireProjectRow(transaction, workspaceId, projectId)
    const [target] = await transaction
      .select({ displayName: users.displayName })
      .from(workspaceMemberships)
      .innerJoin(users, eq(users.id, workspaceMemberships.userId))
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.userId, input.userId)
        )
      )
      .limit(1)
    // Only workspace members can be listed on a project; a stranger's id is
    // answered like a missing one.
    if (!target) throw new Error('Project member unavailable')
    const now = new Date()
    const [member] = await transaction
      .insert(projectMembers)
      .values({ projectId, role: input.role, userId: input.userId, workspaceId })
      .onConflictDoUpdate({
        set: { role: input.role, updatedAt: now },
        target: [projectMembers.projectId, projectMembers.userId],
      })
      .returning()
    if (!member) throw new Error('Project member unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'project.members_changed',
      payload: { actorUserId: principal.userId, projectId, userId: input.userId },
      workspaceId,
    })
    return Object.freeze({
      createdAt: member.createdAt.toISOString(),
      displayName: target.displayName,
      projectId,
      role: member.role,
      updatedAt: member.updatedAt.toISOString(),
      userId: member.userId,
    })
  })
}

export async function removeProjectMember(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef,
  userId: string
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    await requireManager(transaction, workspaceId, principal)
    await requireProjectRow(transaction, workspaceId, projectId)
    const removed = await transaction
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.workspaceId, workspaceId),
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId)
        )
      )
      .returning({ id: projectMembers.id })
    if (!removed.length) return false
    await appendWorkspaceEvent(transaction, {
      eventType: 'project.members_changed',
      payload: { actorUserId: principal.userId, projectId, userId },
      workspaceId,
    })
    return true
  })
}
