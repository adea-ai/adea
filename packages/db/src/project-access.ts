import type { ProjectMemberRole, UserPrincipalRef } from '@adea-ai/types'
import { and, eq, inArray, isNull, notInArray, or, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  channels,
  contentRefs,
  messages,
  projectMembers,
  projects,
  tasks,
  workspaceMemberships,
} from './schema'

type Database = AgentHqDatabase | AgentHqTransaction

/**
 * What one workspace member may see and change across the workspace's
 * projects (ADR 0012).
 *
 * - Owners and admins (`privileged`) see and change every project.
 * - Everyone else sees every `workspace` project, and a `members` project only
 *   when they are listed on it; `hiddenProjectIds` holds the rest.
 * - In a `members` project a listed `viewer` reads only; an `editor` may also
 *   change its content. `workspace` projects keep the workspace role's rules.
 *
 * The scope is resolved with at most two indexed reads and is applied by every
 * query-layer list/get function, so hidden projects, their channels, tasks,
 * messages, read state and search hits never leave the database for a
 * principal who cannot see them.
 */
export type ProjectAccessScope = Readonly<{
  hiddenProjectIds: readonly string[]
  /** Roles on the `members` projects this principal is listed on. */
  memberRoles: ReadonlyMap<string, ProjectMemberRole>
  /** `members` projects of the workspace, visible or not. */
  membersOnlyProjectIds: ReadonlySet<string>
  privileged: boolean
  role: 'owner' | 'admin' | 'member'
  userId: string
}>

/**
 * The scopes of several members of one workspace, in two indexed reads whatever their
 * number. A user with no membership in the workspace has no entry, which is no access.
 */
export async function resolveProjectAccessScopes(
  database: Database,
  workspaceId: string,
  userIds: readonly string[]
): Promise<ReadonlyMap<string, ProjectAccessScope>> {
  const ids = [...new Set(userIds)]
  const scopes = new Map<string, ProjectAccessScope>()
  if (!ids.length) return scopes
  const memberships = await database
    .select({ role: workspaceMemberships.role, userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        inArray(workspaceMemberships.userId, ids)
      )
    )
  if (!memberships.length) return scopes
  // Each members-only project appears once per listed member among `ids`, or once with no
  // member when none of them is listed. A project is hidden to a user unless listed.
  const rows = await database
    .select({
      id: projects.id,
      memberRole: projectMembers.role,
      memberUserId: projectMembers.userId,
    })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), inArray(projectMembers.userId, ids))
    )
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.visibility, 'members')))
  const membersOnlyProjectIds = new Set(rows.map((row) => row.id))
  for (const membership of memberships) {
    const privileged = membership.role === 'owner' || membership.role === 'admin'
    const memberRoles = new Map<string, ProjectMemberRole>()
    for (const row of rows)
      if (row.memberUserId === membership.userId && row.memberRole)
        memberRoles.set(row.id, row.memberRole)
    scopes.set(
      membership.userId,
      Object.freeze({
        hiddenProjectIds: Object.freeze(
          privileged ? [] : [...membersOnlyProjectIds].filter((id) => !memberRoles.has(id))
        ),
        memberRoles,
        membersOnlyProjectIds,
        privileged,
        role: membership.role,
        userId: membership.userId,
      })
    )
  }
  return scopes
}

export async function resolveProjectAccessScope(
  database: Database,
  workspaceId: string,
  userId: string
): Promise<ProjectAccessScope | null> {
  return (await resolveProjectAccessScopes(database, workspaceId, [userId])).get(userId) ?? null
}

/** Resolve the scope or fail with the module's indistinguishable error. */
export async function requireProjectAccessScope(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef,
  unavailable: string
): Promise<ProjectAccessScope> {
  const scope = await resolveProjectAccessScope(database, workspaceId, principal.userId)
  if (!scope) throw new Error(unavailable)
  return scope
}

export function canReadProject(scope: ProjectAccessScope, projectId: string | null | undefined) {
  return !projectId || !scope.hiddenProjectIds.includes(projectId)
}

/**
 * Whether the principal may change content inside a project. Only `members`
 * projects add a rule here; a `workspace` project (or no project) defers to
 * the workspace role checked at the route.
 */
export function canWriteProject(scope: ProjectAccessScope, projectId: string | null | undefined) {
  if (!projectId || scope.privileged) return true
  if (!scope.membersOnlyProjectIds.has(projectId)) return true
  return scope.memberRoles.get(projectId) === 'editor'
}

/**
 * Throw when the project is hidden (indistinguishable from a missing project)
 * or read-only for this principal.
 */
export function requireProjectWrite(
  scope: ProjectAccessScope,
  projectId: string | null | undefined,
  unavailable: string
) {
  if (!canReadProject(scope, projectId)) throw new Error(unavailable)
  if (!canWriteProject(scope, projectId)) throw new Error('Project read-only')
}

/**
 * SQL predicate keeping rows whose project is visible. `null` project columns
 * always pass: `NOT IN` alone would drop them, since `NULL NOT IN (…)` is null.
 */
export function visibleProjectCondition(
  column: PgColumn,
  scope: ProjectAccessScope
): SQL | undefined {
  if (!scope.hiddenProjectIds.length) return undefined
  return or(isNull(column), notInArray(column, [...scope.hiddenProjectIds]))
}

/**
 * SQL predicate keeping rows whose task (if any) belongs to a visible project:
 * artifacts and other task-owned rows inherit their task's project.
 */
export function visibleTaskCondition(
  database: Database,
  column: PgColumn,
  scope: ProjectAccessScope
): SQL | undefined {
  if (!scope.hiddenProjectIds.length) return undefined
  return or(
    isNull(column),
    notInArray(
      column,
      database
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.projectId, [...scope.hiddenProjectIds]))
    )
  )
}

/**
 * Whether the user is an `editor` of the members-only project that owns a
 * channel (or a message's channel). Routes use it to let project editors post
 * without the workspace-wide write role; the query layer still enforces read
 * access and the viewer/editor split on every write.
 */
export async function isMembersProjectEditorForConversation(
  database: Database,
  workspaceId: string,
  userId: string,
  target: Readonly<{ channelId: string } | { messageId: string }>
): Promise<boolean> {
  const [row] =
    'channelId' in target
      ? await database
          .select({ projectId: channels.projectId })
          .from(channels)
          .where(and(eq(channels.id, target.channelId), eq(channels.workspaceId, workspaceId)))
          .limit(1)
      : await database
          .select({ projectId: channels.projectId })
          .from(messages)
          .innerJoin(channels, eq(channels.id, messages.channelId))
          .where(and(eq(messages.id, target.messageId), eq(messages.workspaceId, workspaceId)))
          .limit(1)
  if (!row?.projectId) return false
  const scope = await resolveProjectAccessScope(database, workspaceId, userId)
  return Boolean(
    scope &&
    scope.membersOnlyProjectIds.has(row.projectId) &&
    scope.memberRoles.get(row.projectId) === 'editor'
  )
}

/**
 * Whether a content ref belongs to a project the user can see. A ref follows
 * its task, or its message's channel; an unattached ref belongs to no project.
 * Encrypted replicas and metadata of a hidden project's content stay hidden too.
 */
export async function isContentRefVisible(
  database: Database,
  workspaceId: string,
  userId: string,
  contentRefId: string
): Promise<boolean> {
  const scope = await resolveProjectAccessScope(database, workspaceId, userId)
  if (!scope) return false
  if (!scope.hiddenProjectIds.length) return true
  const [row] = await database
    .select({ channelProjectId: channels.projectId, taskProjectId: tasks.projectId })
    .from(contentRefs)
    .leftJoin(tasks, eq(tasks.id, contentRefs.taskId))
    .leftJoin(messages, eq(messages.id, contentRefs.messageId))
    .leftJoin(channels, eq(channels.id, messages.channelId))
    .where(and(eq(contentRefs.id, contentRefId), eq(contentRefs.workspaceId, workspaceId)))
    .limit(1)
  if (!row) return true
  return canReadProject(scope, row.taskProjectId) && canReadProject(scope, row.channelProjectId)
}
