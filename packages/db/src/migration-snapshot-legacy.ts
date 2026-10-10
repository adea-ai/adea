// Read-only capture of an explicitly versioned historical schema (#1222).
//
// The canonical capture (`captureMigrationSnapshot`, #1248) reads the 20 families registered here
// correctly on a database that stops before 0046; the populated parity proof is in
// migration-cutover-rehearsal.test.ts. What the canonical capture does not do is say which schema it
// read, or refuse a schema it was not written for. This module adds exactly that, around the
// canonical readers, and nothing else:
//
//   1. the requested version is registered;
//   2. the applied migrations are exactly the registered prefix (count and digest);
//   3. every column the verification manifest names exists;
//   4. the application-schema catalog matches the registered fingerprint;
//   5. only then, the canonical capture runs over the verified schema.
//
// Steps 2 to 5 run in one repeatable-read, read-only transaction, so the schema that was verified is
// the schema that was read. Provenance reports what was captured, what is absent by schema, and what
// this path does not read. A family is never reported as empty when it was not read.

import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'

import type { MigrationSnapshotDocument, MigrationSnapshotFamily } from '@adea-ai/types'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  captureMigrationSnapshotInTransaction,
  MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG,
  requireCaptureBound,
  requireCaptureIdentity,
  type MigrationSnapshotCaptureIdentityInput,
} from './migration-snapshot-capture'

const APP = 'app'

/** A family the historical schema does not define: its table must be absent, and the reason is schema-defined. */
export type AbsentFamily = Readonly<{ table: string; reason: string }>

export type LegacySchemaVersion = Readonly<{
  id: string
  /** The journal entry this version stops before (exclusive). */
  before: string
  migrations: Readonly<{ schema: string; table: string; count: number; digest: string }>
  /** sha256 over the application schema's (table, column, type, nullability) rows. */
  catalogFingerprint: string
  /** Columns the canonical readers of the captured families name, by table, verified before any read. */
  requiredColumns: Readonly<Record<string, readonly string[]>>
  /** The families the canonical capture reads for this version. */
  capturedFamilies: readonly MigrationSnapshotFamily[]
  /** Families whose defining table does not exist in this version, with the schema-defined reason. */
  absentBySchema: Readonly<Partial<Record<MigrationSnapshotFamily, AbsentFamily>>>
  /** Families this path does not read, with the reason (unavailable evidence, never zero). */
  notInLegacyRegistry: Readonly<Partial<Record<MigrationSnapshotFamily, string>>>
}>

export type LegacySnapshotRefusalCode =
  | 'unknown_version'
  | 'migration_metadata_mismatch'
  | 'missing_required_column'
  | 'unknown_schema_version'
  | 'registry_family_not_captured'

/** A typed refusal. It carries no partial document. */
export class LegacySnapshotRefusal extends Error {
  readonly code: LegacySnapshotRefusalCode

  constructor(code: LegacySnapshotRefusalCode, message: string) {
    super(message)
    this.name = 'LegacySnapshotRefusal'
    this.code = code
  }
}

export type LegacySnapshotProvenance = Readonly<{
  versionId: string
  migrations: Readonly<{ count: number; digest: string; schema: string; table: string }>
  catalogFingerprint: string
  captured: readonly MigrationSnapshotFamily[]
  absentBySchema: Readonly<Partial<Record<MigrationSnapshotFamily, AbsentFamily>>>
  notInLegacyRegistry: Readonly<Partial<Record<MigrationSnapshotFamily, string>>>
  /** The per-family bound the sections were captured under. */
  limit: number
}>

export type LegacySnapshotCaptureResult = Readonly<{
  document: MigrationSnapshotDocument
  provenance: LegacySnapshotProvenance
}>

/** The statement capability the verification shares: a database or a transaction. */
type Executor = Pick<AgentHqDatabase, 'execute'>

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The 0000–0045 schema: main before `0046_artifact_reference_grants`. The captured families were
 * verified to read through the canonical capture on a database migrated to exactly that prefix (the
 * populated parity proof). The catalog fingerprint and migration digest were read from that database.
 */
const PRE_0046_CAPTURED: readonly MigrationSnapshotFamily[] = [
  'agents',
  'channelParticipants',
  'channels',
  'contentRefs',
  'contentReplicas',
  'events',
  'executionAttempts',
  'identityBindings',
  'invitations',
  'leadTurnRuntime',
  'memberships',
  'messages',
  'projectMembers',
  'projects',
  'readState',
  'runtimeNodes',
  'taskSubmissions',
  'tasks',
  'temporarySessions',
  'workspaces',
]

/**
 * The registered historical schemas. A version is selected only when its migration metadata, its
 * required columns and its catalog fingerprint all match the database. The digest and fingerprint are
 * pinned; `migration-snapshot-legacy.test.ts` re-derives both from a database migrated to the prefix.
 */
export const LEGACY_MIGRATION_SNAPSHOT_VERSIONS: Readonly<Record<string, LegacySchemaVersion>> =
  Object.freeze({
    'pre-0046': {
      id: 'pre-0046',
      before: '0046_artifact_reference_grants',
      migrations: {
        schema: 'drizzle',
        table: '__drizzle_migrations',
        count: 46,
        digest: 'c39ab928239ccc9a60d656baf10236d06666b98fca153c169a492ba22fedd0ed',
      },
      catalogFingerprint: 'a2b90292c3af9aed5d8584e5c0a01792870a8bf57cfba7da4d4ec65388451b67',
      requiredColumns: {
        agents: ['id', 'lifecycle_state', 'project_id', 'workspace_id'],
        auth_identities: ['provider', 'subject', 'user_id'],
        channel_participants: [
          'agent_id',
          'channel_id',
          'principal_kind',
          'user_id',
          'workspace_id',
        ],
        channel_read_states: [
          'channel_id',
          'last_read_sequence',
          'manually_unread',
          'user_id',
          'workspace_id',
        ],
        channels: ['id', 'project_id', 'visibility', 'workspace_id'],
        content_refs: [
          'availability',
          'digest_sha256',
          'id',
          'key_version',
          'message_id',
          'revision',
          'task_id',
          'workspace_id',
        ],
        content_replicas: [
          'availability',
          'content_ref_id',
          'deleted_at',
          'digest_sha256',
          'id',
          'replica_kind',
          'revision',
          'schema_version',
          'workspace_id',
        ],
        lead_turn_runtime: [
          'attempt_id',
          'cancel_requested_at',
          'execution_id',
          'intent_id',
          'published_message_id',
          'runtime_session_id',
          'state',
        ],
        messages: ['channel_id', 'deleted_at', 'id', 'thread_root_message_id', 'workspace_id'],
        project_members: ['project_id', 'role', 'user_id', 'workspace_id'],
        projects: ['id', 'visibility', 'workspace_id'],
        runtime_nodes: [
          'id',
          'kind',
          'pairing_state',
          'platform',
          'revoked_at',
          'software_version',
          'workspace_id',
        ],
        task_execution_attempts: [
          'attempt',
          'location_kind',
          'runtime_node_id',
          'task_id',
          'workspace_id',
        ],
        task_submissions: [
          'agent_id',
          'ciphertext_purged_at',
          'id',
          'location_kind',
          'profile_id',
          'profile_revision',
          'profile_version',
          'runtime_node_id',
          'state',
          'task_id',
          'task_version',
          'workspace_id',
        ],
        tasks: [
          'channel_id',
          'creator_user_id',
          'id',
          'lifecycle_state',
          'message_id',
          'project_id',
          'thread_root_message_id',
          'version',
          'workspace_id',
        ],
        temporary_user_sessions: ['claimed_at', 'id', 'user_id'],
        thread_read_states: [
          'channel_id',
          'last_read_sequence',
          'manually_unread',
          'thread_root_message_id',
          'user_id',
          'workspace_id',
        ],
        workspace_events: [
          'event_type',
          'id',
          'payload',
          'schema_version',
          'workspace_id',
          'workspace_sequence',
        ],
        workspace_invitations: [
          'accepted_at',
          'expires_at',
          'id',
          'invited_by_user_id',
          'revoked_at',
          'role',
          'workspace_id',
        ],
        workspace_memberships: ['role', 'user_id', 'workspace_id'],
        workspaces: ['control_plane_workspace_id', 'deleted_at', 'id', 'owner_user_id'],
      },
      capturedFamilies: PRE_0046_CAPTURED,
      absentBySchema: {
        artifactReferenceGrants: {
          table: 'artifact_reference_grants',
          reason:
            'the artifact_reference_grants table is created by 0046_artifact_reference_grants',
        },
      },
      notInLegacyRegistry: {
        nativeSessions:
          'requires the native-session inventory source, which the legacy path does not supply',
      },
    },
  })

function requireVersion(versionId: string): LegacySchemaVersion {
  const version = Object.prototype.hasOwnProperty.call(
    LEGACY_MIGRATION_SNAPSHOT_VERSIONS,
    versionId
  )
    ? LEGACY_MIGRATION_SNAPSHOT_VERSIONS[versionId]
    : undefined
  if (!version) {
    throw new LegacySnapshotRefusal(
      'unknown_version',
      `legacy snapshot version "${versionId}" is not registered`
    )
  }
  return version
}

/** Migration metadata: the applied hashes must be exactly the registered prefix. */
async function verifyMigrations(tx: Executor, version: LegacySchemaVersion): Promise<void> {
  const { schema, table, count, digest } = version.migrations
  const rows = (await tx.execute(
    sql`select hash from ${sql.identifier(schema)}.${sql.identifier(table)} order by id`
  )) as unknown as { hash: string }[]
  const actual = sha256(rows.map((row) => row.hash).join('\n'))
  if (rows.length !== count || actual !== digest) {
    throw new LegacySnapshotRefusal(
      'migration_metadata_mismatch',
      `applied migrations do not match "${version.id}": expected ${count} entries, found ${rows.length}`
    )
  }
}

/** Every column the verification manifest names must exist before the canonical readers run. */
async function verifyRequiredColumns(tx: Executor, version: LegacySchemaVersion): Promise<void> {
  const present = (await tx.execute(
    sql`select table_name, column_name from information_schema.columns where table_schema = ${APP}`
  )) as unknown as { table_name: string; column_name: string }[]
  const have = new Set(present.map((row) => `${row.table_name}.${row.column_name}`))
  for (const [table, columns] of Object.entries(version.requiredColumns)) {
    for (const column of columns) {
      if (!have.has(`${table}.${column}`)) {
        throw new LegacySnapshotRefusal(
          'missing_required_column',
          `"${version.id}" requires ${APP}.${table}.${column}, which the database does not have`
        )
      }
    }
  }
}

/**
 * Catalog fingerprint of the application schema. Drift from the registered version (an added or
 * dropped table, column, type or nullability) refuses the capture as an unknown schema version.
 */
export async function legacyCatalogFingerprint(tx: Executor): Promise<string> {
  const rows = (await tx.execute(
    sql`select table_name, column_name, data_type, udt_name, is_nullable
        from information_schema.columns where table_schema = ${APP}
        order by table_name, column_name`
  )) as unknown as Record<string, string>[]
  return sha256(
    JSON.stringify(
      rows.map((row) => [
        row.table_name,
        row.column_name,
        row.data_type,
        row.udt_name,
        row.is_nullable,
      ])
    )
  )
}

async function verifyCatalog(tx: Executor, version: LegacySchemaVersion): Promise<void> {
  const tables = (await tx.execute(
    sql`select table_name from information_schema.tables where table_schema = ${APP} and table_type = 'BASE TABLE'`
  )) as unknown as { table_name: string }[]
  const present = new Set(tables.map((row) => row.table_name))
  // An absent family must really be absent: a present table means the database is a later schema.
  for (const [family, absent] of Object.entries(version.absentBySchema) as [
    string,
    AbsentFamily,
  ][]) {
    if (present.has(absent.table)) {
      throw new LegacySnapshotRefusal(
        'unknown_schema_version',
        `"${version.id}" has no ${absent.table} table for ${family}, but the database has one`
      )
    }
  }
  const fingerprint = await legacyCatalogFingerprint(tx)
  if (fingerprint !== version.catalogFingerprint) {
    throw new LegacySnapshotRefusal(
      'unknown_schema_version',
      `the application schema does not match "${version.id}" (catalog fingerprint ${fingerprint.slice(0, 12)})`
    )
  }
}

/**
 * Verified, read-only capture of one registered historical schema version. The input is validated by
 * the canonical validators before any database read, and verification and the canonical capture run
 * in one repeatable-read, read-only transaction.
 */
export async function captureLegacyMigrationSnapshot(
  database: AgentHqDatabase,
  input: Readonly<{
    versionId: string
    identity: MigrationSnapshotCaptureIdentityInput
    limitPerFamily?: number
  }>
): Promise<LegacySnapshotCaptureResult> {
  const version = requireVersion(input.versionId)
  requireCaptureIdentity(input.identity)
  const limit = requireCaptureBound(input.limitPerFamily)

  return database.transaction(async (tx: AgentHqTransaction) => {
    await verifyMigrations(tx, version)
    await verifyRequiredColumns(tx, version)
    await verifyCatalog(tx, version)

    const captured = await captureMigrationSnapshotInTransaction(tx, {
      identity: input.identity,
      limitPerFamily: limit,
      requestedDomains: version.capturedFamilies,
    })
    const notCaptured = captured.domains.filter((domain) => domain.status !== 'captured')
    if (notCaptured.length > 0) {
      throw new LegacySnapshotRefusal(
        'registry_family_not_captured',
        `"${version.id}" registers families the canonical capture did not read: ${notCaptured
          .map((domain) => domain.domain)
          .join(', ')}`
      )
    }

    return Object.freeze({
      document: captured.document,
      provenance: Object.freeze({
        absentBySchema: version.absentBySchema,
        captured: version.capturedFamilies,
        catalogFingerprint: version.catalogFingerprint,
        limit,
        migrations: Object.freeze({
          count: version.migrations.count,
          digest: version.migrations.digest,
          schema: version.migrations.schema,
          table: version.migrations.table,
        }),
        notInLegacyRegistry: version.notInLegacyRegistry,
        versionId: version.id,
      }),
    })
  }, MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG)
}
