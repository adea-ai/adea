import { sql } from 'drizzle-orm'
import { check, index, integer, text, uuid } from 'drizzle-orm/pg-core'

import { entityId, timestampColumns } from './conventions'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

export const roomLifecycleState = appSchema.enum('room_lifecycle_state', ['active', 'archived'])

export const rooms = appSchema.table(
  'rooms',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    functionKey: text('function_key').notNull(),
    templateKey: text('template_key'),
    sortOrder: integer('sort_order').default(0).notNull(),
    lifecycleState: roomLifecycleState('lifecycle_state').default('active').notNull(),
    layoutRef: text('layout_ref'),
    spatialRef: text('spatial_ref'),
    ...timestampColumns(),
  },
  (table) => [
    check('rooms_name_nonempty', sql`length(btrim(${table.name})) > 0`),
    check('rooms_function_key_nonempty', sql`length(btrim(${table.functionKey})) > 0`),
    check('rooms_sort_order_nonnegative', sql`${table.sortOrder} >= 0`),
    index('rooms_workspace_order_idx').on(
      table.workspaceId,
      table.lifecycleState,
      table.sortOrder,
      table.id
    ),
    index('rooms_workspace_function_idx').on(table.workspaceId, table.functionKey),
  ]
)
