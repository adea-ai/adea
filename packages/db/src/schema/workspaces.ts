import { sql } from 'drizzle-orm'
import { check, index, integer, text, unique, uuid } from 'drizzle-orm/pg-core'

import { appSchema } from './schema'
import { entityId, softDeleteColumns, timestampColumns } from './conventions'
import { users } from './identity'

export const workspaceRole = appSchema.enum('workspace_role', ['owner', 'admin', 'member'])

export const workspaces = appSchema.table(
  'workspaces',
  {
    id: entityId(),
    name: text('name').notNull(),
    scene: text('scene').default('home').notNull(),
    /** A theme-provided accent id, or null for the theme default. */
    accent: text('accent'),
    logoKind: text('logo_kind').default('monogram').notNull(),
    /** The emoji grapheme when `logo_kind` is `emoji`; null otherwise. */
    logoValue: text('logo_value'),
    version: integer('version').default(1).notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    ...timestampColumns(),
    ...softDeleteColumns(),
  },
  (table) => [
    unique('workspaces_owner_idempotency_unique').on(table.ownerUserId, table.idempotencyKey),
    check('workspaces_name_nonempty', sql`length(btrim(${table.name})) > 0`),
    check('workspaces_idempotency_nonempty', sql`length(btrim(${table.idempotencyKey})) > 0`),
    check('workspaces_scene_valid', sql`${table.scene} in ('home', 'work')`),
    check(
      'workspaces_accent_valid',
      sql`${table.accent} is null or ${table.accent} in ('violet', 'blue', 'green', 'amber', 'cyan', 'pink')`
    ),
    check(
      'workspaces_logo_valid',
      sql`(${table.logoKind} = 'monogram' and ${table.logoValue} is null) or (${table.logoKind} = 'emoji' and length(${table.logoValue}) between 1 and 16)`
    ),
    check('workspaces_version_positive', sql`${table.version} > 0`),
    index('workspaces_owner_idx').on(table.ownerUserId, table.deletedAt),
    index('workspaces_active_idx').on(table.deletedAt),
  ]
)

export const workspaceMemberships = appSchema.table(
  'workspace_memberships',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: workspaceRole('role').notNull(),
    /** The member's own position for this workspace in their list. */
    sortOrder: integer('sort_order').default(0).notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('workspace_memberships_workspace_user_unique').on(table.workspaceId, table.userId),
    check('workspace_memberships_sort_order_nonnegative', sql`${table.sortOrder} >= 0`),
    index('workspace_memberships_user_idx').on(table.userId, table.workspaceId),
    index('workspace_memberships_user_order_idx').on(table.userId, table.sortOrder),
    index('workspace_memberships_workspace_role_idx').on(table.workspaceId, table.role),
  ]
)

export const authorizationAuditRecords = appSchema.table(
  'authorization_audit_records',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id').notNull(),
    principalKind: text('principal_kind').notNull(),
    principalId: text('principal_id').notNull(),
    permission: text('permission').notNull(),
    decision: text('decision').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestampColumns().createdAt,
  },
  (table) => [
    check('authorization_audit_decision_valid', sql`${table.decision} in ('allowed', 'denied')`),
    index('authorization_audit_workspace_idx').on(table.workspaceId, table.createdAt),
    index('authorization_audit_principal_idx').on(table.principalKind, table.principalId),
  ]
)
