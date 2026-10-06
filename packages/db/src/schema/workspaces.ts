import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

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

export const workspaceInvitationRole = appSchema.enum('workspace_invitation_role', [
  'admin',
  'member',
])

/**
 * A pending or settled invitation into a workspace (ADR 0012). Only the
 * SHA-256 digest of the single-use token is stored; the plaintext is returned
 * once, to the inviter, and never persisted. At most one invitation per
 * (workspace, email) is pending at a time.
 */
export const workspaceInvitations = appSchema.table(
  'workspace_invitations',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Normalized: trimmed and lower-cased. */
    email: text('email').notNull(),
    role: workspaceInvitationRole('role').notNull(),
    tokenDigest: text('token_digest').notNull(),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { mode: 'date', withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    unique('workspace_invitations_token_digest_unique').on(table.tokenDigest),
    uniqueIndex('workspace_invitations_pending_unique')
      .on(table.workspaceId, table.email)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    check(
      'workspace_invitations_email_normalized',
      sql`${table.email} = lower(btrim(${table.email})) and length(${table.email}) between 3 and 320 and position('@' in ${table.email}) > 1`
    ),
    check('workspace_invitations_token_digest_valid', sql`${table.tokenDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'workspace_invitations_accept_consistent',
      sql`(${table.acceptedAt} is null) = (${table.acceptedByUserId} is null)`
    ),
    check(
      'workspace_invitations_settled_once',
      sql`${table.acceptedAt} is null or ${table.revokedAt} is null`
    ),
    index('workspace_invitations_workspace_idx').on(table.workspaceId, table.createdAt),
  ]
)
