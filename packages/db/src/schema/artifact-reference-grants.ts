import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import { entityId, timestampColumns } from './conventions'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

/**
 * Durable registration of artifact-reference grants (M15.03 #1180).
 *
 * One row per grant id carries the grant's COMPLETE identity — source
 * workspace, artifact, granted version, content checksum, audience workspace
 * and expiry — so the policy can authenticate a presented grant field by
 * field against authoritative state. `revision` starts positive and is
 * bumped only by a regrant after revocation; a presented revision below the
 * current one is stale and must never authorize. Revocation is absolute for
 * the revision it marks: the row is retained, so a stale revision can never
 * regain access through a later regrant of the same grant id.
 *
 * `artifact_id` deliberately carries no foreign key: a grant is a
 * revocable authorization record whose identity must survive the artifact
 * it names (deletion is enforced by the evidence gate, not by erasing the
 * record). `expires_at` stores the presented string verbatim because the
 * policy compares the registered and presented expiry by exact string
 * equality; normalizing it would fail honestly registered grants.
 */
export const artifactReferenceGrants = appSchema.table(
  'artifact_reference_grants',
  {
    id: entityId(),
    grantId: text('grant_id').notNull(),
    sourceWorkspaceId: uuid('source_workspace_id').notNull(),
    audienceWorkspaceId: uuid('audience_workspace_id').notNull(),
    artifactId: uuid('artifact_id').notNull(),
    version: integer('version').notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    expiresAt: text('expires_at'),
    revision: integer('revision').notNull(),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    unique('artifact_reference_grants_grant_id_unique').on(table.grantId),
    // Named explicitly: the generated default name for the audience side is
    // 64 characters, one over PostgreSQL's 63-character identifier limit.
    foreignKey({
      columns: [table.sourceWorkspaceId],
      foreignColumns: [workspaces.id],
      name: 'artifact_reference_grants_source_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.audienceWorkspaceId],
      foreignColumns: [workspaces.id],
      name: 'artifact_reference_grants_audience_workspace_fk',
    }).onDelete('cascade'),
    check('artifact_reference_grants_revision_positive', sql`${table.revision} > 0`),
    check('artifact_reference_grants_version_positive', sql`${table.version} > 0`),
    check(
      'artifact_reference_grants_checksum_sha256',
      sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check('artifact_reference_grants_grant_id_nonempty', sql`length(btrim(${table.grantId})) > 0`),
    check(
      'artifact_reference_grants_workspaces_distinct',
      sql`${table.sourceWorkspaceId} <> ${table.audienceWorkspaceId}`
    ),
    index('artifact_reference_grants_source_artifact_idx').on(
      table.sourceWorkspaceId,
      table.artifactId,
      table.audienceWorkspaceId
    ),
  ]
)
