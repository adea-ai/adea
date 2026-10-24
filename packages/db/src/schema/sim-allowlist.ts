import { sql } from 'drizzle-orm'
import { check, text, unique } from 'drizzle-orm/pg-core'

import { entityId, timestampColumns } from './conventions'
import { appSchema } from './schema'

/**
 * The hosted Agent Sim entitlement allowlist: one row grants one workspace one surface, and deleting
 * the row withdraws it. A workspace with no row is not entitled, so the default is deny. Membership
 * never creates a row; an operator adds it. The workspace identifier is text with no foreign key,
 * like the launch codes and sessions, so a row for a workspace that does not exist grants nothing.
 */
export const simWorkspaceAllowlist = appSchema.table(
  'sim_workspace_allowlist',
  {
    id: entityId(),
    workspaceId: text('workspace_id').notNull(),
    surface: text('surface').notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('sim_workspace_allowlist_workspace_surface_unique').on(table.workspaceId, table.surface),
    check('sim_workspace_allowlist_workspace_nonempty', sql`length(${table.workspaceId}) > 0`),
    check(
      'sim_workspace_allowlist_surface_closed',
      sql`${table.surface} in ('hq', 'room-designer', 'character-designer')`
    ),
  ]
)
