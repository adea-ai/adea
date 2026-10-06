import { sql } from 'drizzle-orm'
import { check, index, integer, text, unique, uuid } from 'drizzle-orm/pg-core'

import { entityId, softDeleteColumns, timestampColumns } from './conventions'
import { users } from './identity'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

export const projectLifecycleState = appSchema.enum('project_lifecycle_state', [
  'active',
  'archived',
])

/**
 * Who can see a project (ADR 0012). `workspace` projects are visible to every
 * workspace member; `members` projects only to their project members plus the
 * workspace's owners and admins.
 */
export const projectVisibility = appSchema.enum('project_visibility', ['workspace', 'members'])
export const projectMemberRole = appSchema.enum('project_member_role', ['viewer', 'editor'])

/**
 * Whether a project is backed by a repository. The cloud records only this
 * boolean-level fact; repository roots, remotes and branches stay on the
 * device (ADR 0011).
 */
export const PROJECT_SOURCE_KINDS = ['none', 'repository'] as const

export const projects = appSchema.table(
  'projects',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    iconKey: text('icon_key').notNull(),
    sourceKind: text('source_kind', { enum: PROJECT_SOURCE_KINDS }).default('none').notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    lifecycleState: projectLifecycleState('lifecycle_state').default('active').notNull(),
    visibility: projectVisibility('visibility').default('workspace').notNull(),
    ...timestampColumns(),
    ...softDeleteColumns(),
  },
  (table) => [
    check('projects_name_nonempty', sql`length(btrim(${table.name})) > 0`),
    check('projects_icon_key_nonempty', sql`length(btrim(${table.iconKey})) > 0`),
    check('projects_sort_order_nonnegative', sql`${table.sortOrder} >= 0`),
    check('projects_source_kind_valid', sql`${table.sourceKind} in ('none', 'repository')`),
    index('projects_workspace_order_idx').on(
      table.workspaceId,
      table.lifecycleState,
      table.sortOrder,
      table.id
    ),
    index('projects_workspace_icon_idx').on(table.workspaceId, table.iconKey),
    index('projects_workspace_visibility_idx').on(table.workspaceId, table.visibility),
  ]
)

/**
 * The people listed on a project. Rows only grant access while the project's
 * visibility is `members`; a `workspace` project keeps its rows so switching
 * back restores the same list. `workspace_id` is denormalized so the per-user
 * access scope is one indexed read.
 */
export const projectMembers = appSchema.table(
  'project_members',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: projectMemberRole('role').notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('project_members_project_user_unique').on(table.projectId, table.userId),
    index('project_members_workspace_user_idx').on(table.workspaceId, table.userId),
  ]
)
