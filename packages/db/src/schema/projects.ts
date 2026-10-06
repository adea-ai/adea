import { sql } from 'drizzle-orm'
import { check, index, integer, text, uuid } from 'drizzle-orm/pg-core'

import { entityId, softDeleteColumns, timestampColumns } from './conventions'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

export const projectLifecycleState = appSchema.enum('project_lifecycle_state', [
  'active',
  'archived',
])

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
  ]
)
