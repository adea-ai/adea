import { sql } from 'drizzle-orm'
import { check, text, unique, uuid } from 'drizzle-orm/pg-core'

import { entityId, timestampColumns } from './conventions'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

/**
 * The hosted Agent Sim entitlement allowlist: one row grants one existing workspace one surface, and
 * deleting the row withdraws it. A workspace with no row is not entitled, so the default is deny.
 * Membership never creates a row; an operator adds it.
 *
 * The row is workspace-owned data. The foreign key means a row can only name a workspace that
 * exists, and permanent deletion of the workspace removes its rows. Archiving a workspace or
 * requesting its deletion does not remove the workspace row, so those transitions withdraw the
 * rows and revoke the live Sim sessions in the same transaction (`withdrawSimAccess`); reopening
 * does not bring a grant back. The hosted service never reads `app.workspaces`: it reads only this
 * table, so the lifecycle is enforced where the workspace changes, not by widening its role.
 */
export const simWorkspaceAllowlist = appSchema.table(
  'sim_workspace_allowlist',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    surface: text('surface').notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('sim_workspace_allowlist_workspace_surface_unique').on(table.workspaceId, table.surface),
    check(
      'sim_workspace_allowlist_surface_closed',
      sql`${table.surface} in ('hq', 'room-designer', 'character-designer')`
    ),
  ]
)
