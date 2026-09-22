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

import { entityId, timestampColumns } from './conventions'
import { appSchema } from './schema'
import { contentRefs } from './content-refs'
import { workspaces } from './workspaces'

export const contentReplicaKind = appSchema.enum('content_replica_kind', [
  'local_authority',
  'self_hosted_authority',
  'agent_hq_e2ee_sync',
])
export const contentReplicaAvailability = appSchema.enum('content_replica_availability', [
  'available',
  'offline',
  'missing',
  'deleted',
])

/**
 * Cloud-safe physical content. `ciphertext` includes the authenticated tag;
 * associated data is reconstructed from the immutable identity columns by the
 * authorized endpoint and is never supplied as a cloud-controlled value.
 */
export const contentReplicas = appSchema.table(
  'content_replicas',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contentRefId: uuid('content_ref_id').notNull(),
    replicaKind: contentReplicaKind('replica_kind').notNull(),
    revision: integer('revision').notNull(),
    digestSha256: text('digest_sha256').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    keyEpochId: uuid('key_epoch_id'),
    nonce: text('nonce').notNull(),
    ciphertext: text('ciphertext').notNull(),
    availability: contentReplicaAvailability('availability').notNull(),
    deletedAt: timestamp('deleted_at', { mode: 'date', withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.contentRefId],
      foreignColumns: [contentRefs.workspaceId, contentRefs.id],
      name: 'content_replicas_workspace_content_ref_fk',
    }).onDelete('cascade'),
    check('content_replicas_revision_positive', sql`${table.revision} > 0`),
    check('content_replicas_schema_version_positive', sql`${table.schemaVersion} > 0`),
    check('content_replicas_digest_sha256', sql`${table.digestSha256} ~ '^[0-9a-f]{64}$'`),
    check('content_replicas_nonce_base64url', sql`${table.nonce} ~ '^[A-Za-z0-9_-]{16}$'`),
    check('content_replicas_ciphertext_base64url', sql`${table.ciphertext} ~ '^[A-Za-z0-9_-]+$'`),
    check(
      'content_replicas_ciphertext_size',
      // 16-byte tag minimum and 2 MiB decoded maximum in unpadded base64url.
      sql`length(${table.ciphertext}) between 22 and 2796203`
    ),
    check(
      'content_replicas_kind_epoch_consistent',
      sql`(${table.replicaKind} = 'agent_hq_e2ee_sync' and ${table.keyEpochId} is not null) or (${table.replicaKind} <> 'agent_hq_e2ee_sync' and ${table.keyEpochId} is null)`
    ),
    check(
      'content_replicas_deletion_consistent',
      sql`(${table.availability} = 'deleted' and ${table.deletedAt} is not null) or (${table.availability} <> 'deleted' and ${table.deletedAt} is null)`
    ),
    // PostgreSQL treats NULLs as distinct in a regular unique index. Separate
    // partial indexes make the no-epoch identity just as idempotent as the
    // epoch-bound identity used by E2E replicas.
    uniqueIndex('content_replicas_epoch_identity_idx')
      .on(table.contentRefId, table.revision, table.replicaKind, table.keyEpochId)
      .where(sql`${table.keyEpochId} is not null`),
    uniqueIndex('content_replicas_no_epoch_identity_idx')
      .on(table.contentRefId, table.revision, table.replicaKind)
      .where(sql`${table.keyEpochId} is null`),
    index('content_replicas_workspace_ref_revision_idx').on(
      table.workspaceId,
      table.contentRefId,
      table.revision
    ),
    index('content_replicas_workspace_kind_idx').on(
      table.workspaceId,
      table.replicaKind,
      table.updatedAt
    ),
  ]
)
