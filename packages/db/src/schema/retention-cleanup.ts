import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import {
  CLEANUP_COVERAGE_KINDS,
  RECEIPT_OPERATIONS,
  RECEIPT_OUTCOMES,
  RETENTION_CATEGORIES,
} from '../retention-policy'
import { entityId, timestampColumns } from './conventions'
import { users } from './identity'
import { appSchema } from './schema'
import { runtimeNodes } from './runtime-nodes'
import { workspaces } from './workspaces'

/**
 * Durable retention-cleanup authority for M18.02 (#1221). Three tables hold
 * what the pure gate in `retention-policy` needs and nothing the gate would
 * have to guess:
 *
 * - `retention_holds`: legal or security holds on one subject. A hold is
 *   active while `released_at` is null. Placing and releasing are authoritative
 *   acts: owner or admin of the workspace, at the time of the act.
 * - `retention_deletion_authorizations`: the current authority for one
 *   subject's deletion request. At most one unrevoked authority per subject;
 *   revocation is absolute for its row, and a later grant creates a new row.
 *   Expiry is a fixed instant, never open-ended.
 * - `retention_cleanup_receipts`: append-only receipts from runtime-node
 *   executors. Each receipt is bound to the node that recorded it, carries the
 *   node's signing-key fingerprint for audit, and is unique per workspace
 *   idempotency key, so a repeated delivery is a replay and never a second row.
 *
 * Retention periods are deliberately not stored here: no duration is invented
 * by this schema, and the gate refuses every deletion while periods are unset.
 */

export const retentionCategory = appSchema.enum('retention_category', RETENTION_CATEGORIES)
export const retentionCleanupCoverage = appSchema.enum(
  'retention_cleanup_coverage',
  CLEANUP_COVERAGE_KINDS
)
export const retentionCleanupOperation = appSchema.enum(
  'retention_cleanup_operation',
  RECEIPT_OPERATIONS
)
export const retentionCleanupOutcome = appSchema.enum('retention_cleanup_outcome', RECEIPT_OUTCOMES)

export const retentionHolds = appSchema.table(
  'retention_holds',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    category: retentionCategory('category').notNull(),
    subjectId: text('subject_id').notNull(),
    placedByUserId: uuid('placed_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    placedAt: timestamp('placed_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    releasedAt: timestamp('released_at', { mode: 'date', withTimezone: true }),
    releasedByUserId: uuid('released_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    ...timestampColumns(),
  },
  (table) => [
    index('retention_holds_subject_idx').on(table.workspaceId, table.category, table.subjectId),
    check(
      'retention_holds_subject_bounded',
      sql`char_length(${table.subjectId}) between 1 and 128`
    ),
    check(
      'retention_holds_release_consistent',
      sql`(${table.releasedAt} is null) = (${table.releasedByUserId} is null)`
    ),
  ]
)

export const retentionDeletionAuthorizations = appSchema.table(
  'retention_deletion_authorizations',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    category: retentionCategory('category').notNull(),
    subjectId: text('subject_id').notNull(),
    grantedByUserId: uuid('granted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    ...timestampColumns(),
  },
  (table) => [
    // At most one unrevoked authority per subject: a second live grant conflicts.
    uniqueIndex('retention_deletion_authorizations_live_uidx')
      .on(table.workspaceId, table.category, table.subjectId)
      .where(sql`${table.revokedAt} is null`),
    check(
      'retention_deletion_authorizations_subject_bounded',
      sql`char_length(${table.subjectId}) between 1 and 128`
    ),
    check(
      'retention_deletion_authorizations_expiry_after_grant',
      sql`${table.expiresAt} > ${table.grantedAt}`
    ),
    check(
      'retention_deletion_authorizations_revocation_consistent',
      sql`(${table.revokedAt} is null) = (${table.revokedByUserId} is null)
        and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.grantedAt})`
    ),
  ]
)

export const retentionCleanupReceipts = appSchema.table(
  'retention_cleanup_receipts',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** The recording executor. The composite key keeps it in this workspace. */
    runtimeNodeId: uuid('runtime_node_id').notNull(),
    executorSigningFingerprint: text('executor_signing_fingerprint').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    category: retentionCategory('category').notNull(),
    subjectId: text('subject_id').notNull(),
    coverage: retentionCleanupCoverage('coverage').notNull(),
    operation: retentionCleanupOperation('operation').notNull(),
    outcome: retentionCleanupOutcome('outcome').notNull(),
    residualCount: integer('residual_count').notNull(),
    observedAt: timestamp('observed_at', { mode: 'date', withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.runtimeNodeId],
      foreignColumns: [runtimeNodes.workspaceId, runtimeNodes.id],
      name: 'retention_cleanup_receipts_executor_fk',
    }),
    uniqueIndex('retention_cleanup_receipts_idempotency_uidx').on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index('retention_cleanup_receipts_subject_idx').on(
      table.workspaceId,
      table.category,
      table.subjectId,
      table.coverage,
      table.operation
    ),
    check(
      'retention_cleanup_receipts_idempotency_bounded',
      sql`char_length(${table.idempotencyKey}) between 1 and 128`
    ),
    check(
      'retention_cleanup_receipts_subject_bounded',
      sql`char_length(${table.subjectId}) between 1 and 128`
    ),
    check('retention_cleanup_receipts_residual_nonnegative', sql`${table.residualCount} >= 0`),
  ]
)
