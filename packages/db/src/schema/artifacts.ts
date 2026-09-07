import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import { agents } from './agents'
import { entityId, timestampColumns, type JsonObject } from './conventions'
import { appSchema } from './schema'
import { tasks } from './tasks'
import { workspaces } from './workspaces'

export const artifactLocationType = appSchema.enum('artifact_location_type', [
  'object_store',
  'runtime_node',
  'external_harness',
])
export const artifactAvailability = appSchema.enum('artifact_availability', [
  'pending',
  'available',
  'unavailable',
  'quarantined',
  'failed',
])
export const artifactDeletionState = appSchema.enum('artifact_deletion_state', [
  'active',
  'deleted',
])
export const artifactSensitivity = appSchema.enum('artifact_sensitivity', [
  'workspace',
  'sensitive',
  'restricted',
])
export const artifactRetentionPolicy = appSchema.enum('artifact_retention_policy', [
  'ephemeral',
  'standard',
  'retain',
])
export const artifactPrincipalKind = appSchema.enum('artifact_principal_kind', [
  'user',
  'service',
  'runtime_node',
  'agent',
  'worker',
  'system',
])

export const artifacts = appSchema.table(
  'artifacts',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerPrincipalKind: artifactPrincipalKind('owner_principal_kind').notNull(),
    ownerPrincipalId: text('owner_principal_id').notNull(),
    sourcePrincipalKind: artifactPrincipalKind('source_principal_kind').notNull(),
    sourcePrincipalId: text('source_principal_id').notNull(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    executionRef: text('execution_ref'),
    locationType: artifactLocationType('location_type').notNull(),
    locationRef: text('location_ref').notNull(),
    runtimeNodeId: text('runtime_node_id'),
    externalHarnessId: text('external_harness_id'),
    filename: text('filename').notNull(),
    mediaType: text('media_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    provenance: jsonb('provenance').$type<JsonObject>().default({}).notNull(),
    sensitivity: artifactSensitivity('sensitivity').default('workspace').notNull(),
    retentionPolicy: artifactRetentionPolicy('retention_policy').default('standard').notNull(),
    availability: artifactAvailability('availability').default('pending').notNull(),
    deletionState: artifactDeletionState('deletion_state').default('active').notNull(),
    deletedAt: timestamp('deleted_at', { mode: 'date', withTimezone: true }),
    deletedByPrincipalKind: artifactPrincipalKind('deleted_by_principal_kind'),
    deletedByPrincipalId: text('deleted_by_principal_id'),
    sourceArtifactRef: text('source_artifact_ref').notNull(),
    createPayloadHash: text('create_payload_hash').notNull(),
    version: integer('version').default(1).notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('artifacts_workspace_source_unique').on(table.workspaceId, table.sourceArtifactRef),
    check('artifacts_owner_principal_nonempty', sql`length(btrim(${table.ownerPrincipalId})) > 0`),
    check(
      'artifacts_source_principal_nonempty',
      sql`length(btrim(${table.sourcePrincipalId})) > 0`
    ),
    check('artifacts_source_ref_nonempty', sql`length(btrim(${table.sourceArtifactRef})) > 0`),
    check('artifacts_location_ref_nonempty', sql`length(btrim(${table.locationRef})) > 0`),
    check('artifacts_filename_nonempty', sql`length(btrim(${table.filename})) > 0`),
    check('artifacts_media_type_nonempty', sql`length(btrim(${table.mediaType})) > 0`),
    check('artifacts_size_nonnegative', sql`${table.sizeBytes} >= 0`),
    check('artifacts_checksum_sha256', sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    check('artifacts_version_positive', sql`${table.version} > 0`),
    check(
      'artifacts_location_consistent',
      sql`(${table.locationType} = 'object_store' and ${table.runtimeNodeId} is null and ${table.externalHarnessId} is null) or (${table.locationType} = 'runtime_node' and length(btrim(${table.runtimeNodeId})) > 0 and ${table.externalHarnessId} is null) or (${table.locationType} = 'external_harness' and ${table.runtimeNodeId} is null and length(btrim(${table.externalHarnessId})) > 0)`
    ),
    check(
      'artifacts_deletion_consistent',
      sql`(${table.deletionState} = 'active' and ${table.deletedAt} is null and ${table.deletedByPrincipalKind} is null and ${table.deletedByPrincipalId} is null) or (${table.deletionState} = 'deleted' and ${table.deletedAt} is not null and ${table.deletedByPrincipalKind} is not null and length(btrim(${table.deletedByPrincipalId})) > 0)`
    ),
    index('artifacts_workspace_lifecycle_idx').on(
      table.workspaceId,
      table.deletionState,
      table.availability,
      table.createdAt
    ),
    index('artifacts_task_idx').on(table.workspaceId, table.taskId),
    index('artifacts_agent_idx').on(table.workspaceId, table.agentId),
    index('artifacts_execution_idx').on(table.workspaceId, table.executionRef),
  ]
)
