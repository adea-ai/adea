// Read-only legacy snapshot capture for explicitly versioned historical schemas (#1222).
//
// The canonical capture (`captureMigrationSnapshot`, #1248) projects today's typed schema. On a
// database that has not yet applied a later migration, a typed projection can name a column or a
// relation the database does not have, so the capture cannot run there. This module reads the same
// contract records with explicit SQL, but only for a schema version that is registered here and
// verified against the database before a single row is read:
//
//   1. the version id is known (an unknown id is refused);
//   2. the applied migration metadata matches the registered journal prefix (count and digest);
//   3. every column the version's readers name exists (a missing one is refused, by name);
//   4. the application-schema catalog fingerprint matches the registered version (drift is refused).
//
// Nothing is substituted. A family the historical schema does not define is reported as
// `absentBySchema` (the schema defines no table for it), and a family this path does not read is
// reported as `notInLegacyRegistry`. Both are absent from the document, which the comparator reads
// as an unknown domain, never as zero records. Records keep the #1248 contract shape, so the same
// comparator compares a legacy `before` document with a canonical `after` document.

import { createHash } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'

import {
  MIGRATION_SNAPSHOT_FORMAT_VERSION,
  MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION,
  migrationSnapshotFamilies,
  type MigrationSnapshotDocument,
  type MigrationSnapshotFamily,
  type MigrationSnapshotIdentity,
  type MigrationSnapshotRecord,
  type MigrationSnapshotSection,
  type MigrationSnapshotSections,
} from '@adea-ai/types'

import type { AgentHqDatabase } from './connection'
import {
  collectBoundedRecords,
  MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG,
  migrationSnapshotEventPayloadDigestField,
  type MigrationSnapshotCaptureIdentityInput,
} from './migration-snapshot-capture'

type Row = Readonly<Record<string, unknown>>

/** The statement capability the readers share: a database or a read-only transaction. */
type Executor = Pick<AgentHqDatabase, 'execute'>

/** A read the historical reader performs: one table and the columns it names. */
type FamilyReads = Readonly<Record<string, readonly string[]>>

type FamilyReader = Readonly<{
  reads: FamilyReads
  fetch: (limit: number, offset: number) => SQL
  toRecord: (row: Row, capturedAt: Date) => MigrationSnapshotRecord
}>

/** The historical schema's migration metadata: where it lives and what it must contain. */
type MigrationMetadata = Readonly<{
  schema: string
  table: string
  count: number
  /** sha256 over the applied migration hashes, in journal order, joined by newlines. */
  digest: string
}>

/** A family the historical schema does not define: its table must be absent, and the reason is schema-defined. */
export type AbsentFamily = Readonly<{ table: string; reason: string }>

export type LegacySchemaVersion = Readonly<{
  id: string
  /** The journal entry this version ends before (exclusive). */
  before: string
  migrations: MigrationMetadata
  /** sha256 over the application schema's (table, column, type, nullability) rows. */
  catalogFingerprint: string
  /** Families whose defining table does not exist in this version, with the schema-defined reason. */
  absentBySchema: Readonly<Partial<Record<MigrationSnapshotFamily, AbsentFamily>>>
  /** Families this legacy path does not read, with the reason (unavailable evidence, not zero). */
  notInLegacyRegistry: Readonly<Partial<Record<MigrationSnapshotFamily, string>>>
  readers: Readonly<Partial<Record<MigrationSnapshotFamily, FamilyReader>>>
}>

export type LegacySnapshotRefusalCode =
  | 'unknown_version'
  | 'migration_metadata_mismatch'
  | 'missing_required_column'
  | 'unknown_schema_version'

/** A refusal is typed and carries no partial document. */
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
  /** The per-family limit the sections were captured under. */
  limit: number
}>

export type LegacySnapshotCaptureResult = Readonly<{
  document: MigrationSnapshotDocument
  provenance: LegacySnapshotProvenance
}>

const APP = 'app'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function ident(name: string) {
  return sql.identifier(name)
}

function columnList(columns: readonly string[]): SQL {
  return sql.join(
    columns.map((column) => ident(column)),
    sql`, `
  )
}

function qualified(table: string): SQL {
  return sql`${ident(APP)}.${ident(table)}`
}

/** A plain one-table reader: explicit columns, explicit ordering, bounded by `limit`/`offset`. */
function singleTable(table: string, columns: readonly string[], orderBy: readonly string[]) {
  return (limit: number, offset: number): SQL =>
    sql`select ${columnList(columns)} from ${qualified(table)} order by ${columnList(orderBy)} limit ${limit} offset ${offset}`
}

/** Driver integers arrive as strings for bigint columns; a value outside the safe range stays a string. */
function numberOf(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(parsed) ? parsed : (value as number)
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : (value as string)
}

function invitationState(row: Row, now: Date): 'accepted' | 'expired' | 'pending' | 'revoked' {
  if (row.accepted_at) return 'accepted'
  if (row.revoked_at) return 'revoked'
  // Raw driver rows carry timestamps as text; the comparison is on the instant, not the text.
  const expiresAt =
    row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at))
  return expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending'
}

/**
 * The 0000–0045 schema: main before `0046_artifact_reference_grants`. Its tables and columns were
 * read from a database migrated to exactly that prefix, and the readers name only those columns.
 */
const PRE_0046_READERS: Partial<Record<MigrationSnapshotFamily, FamilyReader>> = {
  agents: {
    reads: { agents: ['id', 'lifecycle_state', 'project_id', 'workspace_id'] },
    fetch: singleTable('agents', ['id', 'lifecycle_state', 'project_id', 'workspace_id'], ['id']),
    toRecord: (row) =>
      ({
        agentId: row.id,
        family: 'agents',
        lifecycleState: row.lifecycle_state,
        projectId: nullableText(row.project_id),
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  channelParticipants: {
    reads: {
      channel_participants: ['agent_id', 'channel_id', 'principal_kind', 'user_id', 'workspace_id'],
    },
    fetch: singleTable(
      'channel_participants',
      ['agent_id', 'channel_id', 'principal_kind', 'user_id', 'workspace_id'],
      ['channel_id', 'principal_kind', 'user_id', 'agent_id']
    ),
    toRecord: (row) =>
      ({
        channelId: row.channel_id,
        family: 'channelParticipants',
        principalId: row.user_id ?? row.agent_id,
        principalKind: row.principal_kind,
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  channels: {
    reads: { channels: ['id', 'project_id', 'visibility', 'workspace_id'] },
    fetch: singleTable('channels', ['id', 'project_id', 'visibility', 'workspace_id'], ['id']),
    toRecord: (row) =>
      ({
        channelId: row.id,
        family: 'channels',
        projectId: nullableText(row.project_id),
        visibility: row.visibility,
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  contentRefs: {
    reads: {
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
    },
    fetch: singleTable(
      'content_refs',
      [
        'availability',
        'digest_sha256',
        'id',
        'key_version',
        'message_id',
        'revision',
        'task_id',
        'workspace_id',
      ],
      ['id']
    ),
    toRecord: (row) =>
      ({
        availability: row.availability,
        contentRefId: row.id,
        digestSha256: row.digest_sha256,
        family: 'contentRefs',
        keyVersion: numberOf(row.key_version),
        messageId: nullableText(row.message_id),
        revision: numberOf(row.revision),
        taskId: nullableText(row.task_id),
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  contentReplicas: {
    reads: {
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
    },
    fetch: singleTable(
      'content_replicas',
      [
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
      ['id']
    ),
    toRecord: (row) =>
      ({
        availability: row.availability,
        contentRefId: row.content_ref_id,
        deleted: row.deleted_at !== null && row.deleted_at !== undefined,
        digestSha256: row.digest_sha256,
        family: 'contentReplicas',
        replicaId: row.id,
        replicaKind: row.replica_kind,
        revision: numberOf(row.revision),
        schemaVersion: numberOf(row.schema_version),
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  events: {
    reads: {
      workspace_events: [
        'event_type',
        'id',
        'payload',
        'schema_version',
        'workspace_id',
        'workspace_sequence',
      ],
    },
    fetch: singleTable(
      'workspace_events',
      ['event_type', 'id', 'payload', 'schema_version', 'workspace_id', 'workspace_sequence'],
      ['id']
    ),
    toRecord: (row) =>
      ({
        eventId: row.id,
        eventType: row.event_type,
        family: 'events',
        payloadDigest: migrationSnapshotEventPayloadDigestField(row.payload),
        schemaVersion: numberOf(row.schema_version),
        workspaceId: row.workspace_id,
        workspaceSequence: numberOf(row.workspace_sequence),
      }) as MigrationSnapshotRecord,
  },
  executionAttempts: {
    reads: {
      task_execution_attempts: [
        'attempt',
        'location_kind',
        'runtime_node_id',
        'task_id',
        'workspace_id',
      ],
    },
    fetch: singleTable(
      'task_execution_attempts',
      ['attempt', 'location_kind', 'runtime_node_id', 'task_id', 'workspace_id'],
      ['task_id', 'attempt']
    ),
    toRecord: (row) =>
      ({
        attempt: numberOf(row.attempt),
        family: 'executionAttempts',
        locationKind: row.location_kind,
        runtimeNodeId: nullableText(row.runtime_node_id),
        taskId: row.task_id,
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  identityBindings: {
    reads: { auth_identities: ['provider', 'subject', 'user_id'] },
    fetch: singleTable(
      'auth_identities',
      ['provider', 'subject', 'user_id'],
      ['provider', 'subject']
    ),
    toRecord: (row) =>
      ({
        family: 'identityBindings',
        provider: row.provider,
        subject: row.subject,
        userId: row.user_id,
      }) as MigrationSnapshotRecord,
  },
  invitations: {
    reads: {
      workspace_invitations: [
        'accepted_at',
        'expires_at',
        'id',
        'invited_by_user_id',
        'revoked_at',
        'role',
        'workspace_id',
      ],
    },
    fetch: singleTable(
      'workspace_invitations',
      [
        'accepted_at',
        'expires_at',
        'id',
        'invited_by_user_id',
        'revoked_at',
        'role',
        'workspace_id',
      ],
      ['id']
    ),
    toRecord: (row, capturedAt) =>
      ({
        family: 'invitations',
        invitationId: row.id,
        invitedByUserId: row.invited_by_user_id,
        role: row.role,
        state: invitationState(row, capturedAt),
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  leadTurnRuntime: {
    reads: {
      lead_turn_runtime: [
        'attempt_id',
        'cancel_requested_at',
        'execution_id',
        'intent_id',
        'published_message_id',
        'runtime_session_id',
        'state',
      ],
    },
    fetch: singleTable(
      'lead_turn_runtime',
      [
        'attempt_id',
        'cancel_requested_at',
        'execution_id',
        'intent_id',
        'published_message_id',
        'runtime_session_id',
        'state',
      ],
      ['intent_id']
    ),
    toRecord: (row) =>
      ({
        attemptId: row.attempt_id,
        cancelRequested: row.cancel_requested_at !== null && row.cancel_requested_at !== undefined,
        executionId: row.execution_id,
        family: 'leadTurnRuntime',
        intentId: row.intent_id,
        publishedMessageId: nullableText(row.published_message_id),
        runtimeSessionId: nullableText(row.runtime_session_id),
        state: row.state,
      }) as MigrationSnapshotRecord,
  },
  memberships: {
    reads: { workspace_memberships: ['role', 'user_id', 'workspace_id'] },
    fetch: singleTable(
      'workspace_memberships',
      ['role', 'user_id', 'workspace_id'],
      ['workspace_id', 'user_id']
    ),
    toRecord: (row) =>
      ({
        family: 'memberships',
        role: row.role,
        userId: row.user_id,
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  messages: {
    reads: {
      messages: ['channel_id', 'deleted_at', 'id', 'thread_root_message_id', 'workspace_id'],
    },
    fetch: singleTable(
      'messages',
      ['channel_id', 'deleted_at', 'id', 'thread_root_message_id', 'workspace_id'],
      ['id']
    ),
    toRecord: (row) =>
      ({
        channelId: row.channel_id,
        deleted: row.deleted_at !== null && row.deleted_at !== undefined,
        family: 'messages',
        messageId: row.id,
        threadRootMessageId: nullableText(row.thread_root_message_id),
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  projectMembers: {
    reads: { project_members: ['project_id', 'role', 'user_id', 'workspace_id'] },
    fetch: singleTable(
      'project_members',
      ['project_id', 'role', 'user_id', 'workspace_id'],
      ['project_id', 'user_id']
    ),
    toRecord: (row) =>
      ({
        family: 'projectMembers',
        projectId: row.project_id,
        role: row.role,
        userId: row.user_id,
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  projects: {
    reads: { projects: ['id', 'visibility', 'workspace_id'] },
    fetch: singleTable('projects', ['id', 'visibility', 'workspace_id'], ['id']),
    toRecord: (row) =>
      ({
        family: 'projects',
        projectId: row.id,
        visibility: row.visibility,
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  readState: {
    reads: {
      channel_read_states: [
        'channel_id',
        'last_read_sequence',
        'manually_unread',
        'user_id',
        'workspace_id',
      ],
      thread_read_states: [
        'channel_id',
        'last_read_sequence',
        'manually_unread',
        'thread_root_message_id',
        'user_id',
        'workspace_id',
      ],
    },
    fetch: (limit, offset) =>
      sql`
        select frontiers.workspace_id, frontiers.user_id, frontiers.channel_id,
          frontiers.thread_root_message_id, frontiers.last_read_sequence, frontiers.manually_unread
        from (
          select ${ident('workspace_id')}, ${ident('user_id')}, ${ident('channel_id')},
            null::uuid as thread_root_message_id, ${ident('last_read_sequence')}, ${ident('manually_unread')}
          from ${qualified('channel_read_states')}
          union all
          select ${ident('workspace_id')}, ${ident('user_id')}, ${ident('channel_id')},
            ${ident('thread_root_message_id')}, ${ident('last_read_sequence')}, ${ident('manually_unread')}
          from ${qualified('thread_read_states')}
        ) frontiers
        order by frontiers.workspace_id, frontiers.user_id, frontiers.channel_id,
          frontiers.thread_root_message_id
        limit ${limit} offset ${offset}`,
    toRecord: (row) =>
      ({
        channelId: row.channel_id,
        family: 'readState',
        lastReadSequence: numberOf(row.last_read_sequence),
        manuallyUnread: row.manually_unread === true,
        threadRootMessageId: nullableText(row.thread_root_message_id),
        userId: row.user_id,
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  runtimeNodes: {
    reads: {
      runtime_nodes: [
        'id',
        'kind',
        'pairing_state',
        'platform',
        'revoked_at',
        'software_version',
        'workspace_id',
      ],
    },
    fetch: singleTable(
      'runtime_nodes',
      ['id', 'kind', 'pairing_state', 'platform', 'revoked_at', 'software_version', 'workspace_id'],
      ['id']
    ),
    toRecord: (row) =>
      ({
        family: 'runtimeNodes',
        kind: row.kind,
        pairingState: row.pairing_state,
        platform: row.platform,
        revoked: row.revoked_at !== null && row.revoked_at !== undefined,
        runtimeNodeId: row.id,
        softwareVersion: row.software_version,
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  taskSubmissions: {
    reads: {
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
    },
    fetch: singleTable(
      'task_submissions',
      [
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
      ['id']
    ),
    toRecord: (row) =>
      ({
        agentId: row.agent_id,
        ciphertextPurged:
          row.ciphertext_purged_at !== null && row.ciphertext_purged_at !== undefined,
        family: 'taskSubmissions',
        locationKind: row.location_kind,
        profileId: row.profile_id,
        profileRevision: numberOf(row.profile_revision),
        profileVersion: row.profile_version,
        runtimeNodeId: row.runtime_node_id,
        state: row.state,
        submissionId: row.id,
        taskId: row.task_id,
        taskVersion: numberOf(row.task_version),
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  tasks: {
    reads: {
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
    },
    fetch: singleTable(
      'tasks',
      [
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
      ['id']
    ),
    toRecord: (row) =>
      ({
        channelId: nullableText(row.channel_id),
        creatorUserId: row.creator_user_id,
        family: 'tasks',
        lifecycleState: row.lifecycle_state,
        messageId: nullableText(row.message_id),
        projectId: nullableText(row.project_id),
        taskId: row.id,
        threadRootMessageId: nullableText(row.thread_root_message_id),
        version: numberOf(row.version),
        workspaceId: row.workspace_id,
      }) as MigrationSnapshotRecord,
  },
  temporarySessions: {
    reads: { temporary_user_sessions: ['claimed_at', 'id', 'user_id'] },
    fetch: singleTable('temporary_user_sessions', ['claimed_at', 'id', 'user_id'], ['id']),
    toRecord: (row) =>
      ({
        claimed: row.claimed_at !== null && row.claimed_at !== undefined,
        family: 'temporarySessions',
        sessionId: row.id,
        userId: row.user_id,
      }) as MigrationSnapshotRecord,
  },
  workspaces: {
    reads: {
      workspaces: ['control_plane_workspace_id', 'deleted_at', 'id', 'owner_user_id'],
    },
    fetch: singleTable(
      'workspaces',
      ['control_plane_workspace_id', 'deleted_at', 'id', 'owner_user_id'],
      ['id']
    ),
    toRecord: (row) =>
      ({
        archived: row.deleted_at !== null && row.deleted_at !== undefined,
        controlPlaneWorkspaceId: row.control_plane_workspace_id,
        family: 'workspaces',
        ownerUserId: row.owner_user_id,
        workspaceId: row.id,
      }) as MigrationSnapshotRecord,
  },
}

/**
 * The registered historical schemas. A version is selected only when its migration metadata, its
 * required columns and its catalog fingerprint all match the database. The fingerprint and digest are
 * pinned from a database migrated to exactly the prefix; `legacy-snapshot.test.ts` re-derives both.
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
      absentBySchema: {
        artifactReferenceGrants: {
          table: 'artifact_reference_grants',
          reason:
            'the artifact_reference_grants table is created by 0046_artifact_reference_grants',
        },
      },
      notInLegacyRegistry: {
        nativeSessions:
          'requires the native-session inventory source, which the legacy path does not read',
      },
      readers: PRE_0046_READERS,
    },
  })

/** Every family the version reads, in contract order. */
export function legacyCapturedFamilies(
  version: LegacySchemaVersion
): readonly MigrationSnapshotFamily[] {
  return migrationSnapshotFamilies.filter((family) => version.readers[family] !== undefined)
}

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

function requireIdentity(input: MigrationSnapshotCaptureIdentityInput): MigrationSnapshotIdentity {
  for (const field of ['rehearsalId', 'snapshotId', 'source'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim().length === 0) {
      throw new Error(`legacy snapshot identity.${field} must be a non-empty string`)
    }
  }
  return Object.freeze({
    formatVersion: MIGRATION_SNAPSHOT_FORMAT_VERSION,
    rehearsalId: input.rehearsalId,
    snapshotId: input.snapshotId,
    source: input.source,
  })
}

/** Migration metadata: the applied hashes must be exactly the registered prefix. */
async function verifyMigrations(tx: Executor, version: LegacySchemaVersion): Promise<void> {
  const { schema, table, count, digest } = version.migrations
  const rows = (await tx.execute(
    sql`select hash from ${ident(schema)}.${ident(table)} order by id`
  )) as unknown as { hash: string }[]
  const actual = sha256(rows.map((row) => row.hash).join('\n'))
  if (rows.length !== count || actual !== digest) {
    throw new LegacySnapshotRefusal(
      'migration_metadata_mismatch',
      `applied migrations do not match "${version.id}": expected ${count} entries, found ${rows.length}`
    )
  }
}

/** Every column the registered readers name must exist before any reader runs. */
async function verifyRequiredColumns(
  tx: Executor,
  version: LegacySchemaVersion,
  families: readonly MigrationSnapshotFamily[]
): Promise<void> {
  const present = (await tx.execute(
    sql`select table_name, column_name from information_schema.columns where table_schema = ${APP}`
  )) as unknown as { table_name: string; column_name: string }[]
  const have = new Set(present.map((row) => `${row.table_name}.${row.column_name}`))
  for (const family of families) {
    for (const [table, columns] of Object.entries(version.readers[family]!.reads)) {
      for (const column of columns) {
        if (!have.has(`${table}.${column}`)) {
          throw new LegacySnapshotRefusal(
            'missing_required_column',
            `"${version.id}" requires ${APP}.${table}.${column} for ${family}, which the database does not have`
          )
        }
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
 * Read-only capture of one registered historical schema version. Verification and every read run in
 * one repeatable-read, read-only transaction, so the verified schema is the schema that was read.
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
  const identity = requireIdentity(input.identity)
  const limit = input.limitPerFamily ?? MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION
  const families = legacyCapturedFamilies(version)
  const capturedAt = input.identity.capturedAt

  return database.transaction(async (tx) => {
    await verifyMigrations(tx, version)
    await verifyRequiredColumns(tx, version, families)
    await verifyCatalog(tx, version)

    const sections: Partial<Record<MigrationSnapshotFamily, MigrationSnapshotSection>> = {}
    for (const family of families) {
      const reader = version.readers[family]!
      const { records, truncated } = await collectBoundedRecords({
        fetchPage: async (offset, rowsBound) =>
          (await tx.execute(reader.fetch(rowsBound, offset))) as unknown as Row[],
        limit,
        toRecord: (row) => reader.toRecord(row as Row, capturedAt),
      })
      sections[family] = Object.freeze({
        limit,
        records: Object.freeze(records),
        truncated,
      })
    }

    const document: MigrationSnapshotDocument = Object.freeze({
      identity,
      sections: Object.freeze(sections) as MigrationSnapshotSections,
    })
    return Object.freeze({
      document,
      provenance: Object.freeze({
        absentBySchema: version.absentBySchema,
        captured: families,
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
