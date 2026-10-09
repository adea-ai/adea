// Read-only snapshot capture for migration rehearsal (M18.01, #1181).
//
// Capture is the WRITE side of nothing: it reads real product records and
// produces the frozen snapshot documents the comparator in
// `migration-snapshot-comparator.ts` consumes. It never backfills, deletes,
// cuts over or rolls anything back — every read below runs inside ONE
// REPEATABLE READ, READ ONLY transaction, so the database structurally
// refuses the capture a write and every family is observed at a single
// database snapshot (families and pages can never mix states).
//
// Design, mirroring the comparator's epistemics:
//
// - CONSISTENT SNAPSHOT: `captureMigrationSnapshot` opens one transaction
//   with `MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG`; the whole document
//   is read inside it. `captureMigrationSnapshotInTransaction` runs the same
//   read inside a caller-owned transaction that already holds the snapshot.
// - PAGINATION + EXPLICIT COMPLETENESS: every family read is offset-paginated
//   (the repo's search-paging convention) with a one-row probe per page, so
//   exhaustion is proven, not assumed. A scan that stops at the family bound
//   before exhausting the domain records `truncated: true` plus the applied
//   `limit` on the section; an exhausted scan records `truncated: false`.
//   Missing truncation evidence can never imply completeness — `truncated`
//   is always present, exactly what the comparator requires.
// - UNSUPPORTED DOMAINS STAY UNKNOWN: capture only inventories its supported
//   families. A requested domain outside the support set returns a domain
//   status of `unknown` with a typed reason and simply leaves the section
//   absent from the document — the comparator reads an absent section as
//   `unknown_domain`, never as an empty success.
// - DETERMINISM: output carries only the comparator's allow-listed record
//   fields; records are ordered by the comparator's stable identity (a plain
//   code-unit sort, independent of database collation and page size);
//   sections are emitted in contract-family order; the invitation lifecycle
//   state is derived from an injectable `capturedAt` instead of the wall
//   clock. The same database state with the same identity inputs yields
//   byte-identical documents. No credentials, DSNs, message bodies, emails,
//   token digests or timestamps travel — the record contract excludes them
//   and capture never selects them.
//
// Scope honesty: capture feeds comparison; neither is migration acceptance.
// The database handle (or DSN-derived connection) is always an explicit
// argument — nothing here reads `DATABASE_URL` or defaults to any
// environment. Rows whose values exceed the snapshot contract's documented
// bounds are carried verbatim and will be quarantined by the comparator as
// typed `limit` issues; capture never drops or repairs a row silently.

import { createHash } from 'node:crypto'

import { asc } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import type {
  MigrationSnapshotDocument,
  MigrationSnapshotFamily,
  MigrationSnapshotIdentity,
  MigrationSnapshotRecord,
  MigrationSnapshotRecordFor,
  MigrationSnapshotSection,
  MigrationSnapshotSections,
} from '@adea-ai/types'
import {
  isMigrationSnapshotFamily,
  migrationSnapshotFamilies,
  MIGRATION_SNAPSHOT_FORMAT_VERSION,
  MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION,
} from '@adea-ai/types'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  agents,
  authIdentities,
  channelParticipants,
  channels,
  channelReadStates,
  contentRefs,
  messages,
  projectMembers,
  projects,
  taskExecutionAttempts,
  tasks,
  temporaryUserSessions,
  threadReadStates,
  workspaceEvents,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
} from './schema'

/**
 * The transaction configuration every whole-document capture runs under: one
 * REPEATABLE READ transaction, declared READ ONLY so the database rejects any
 * write the capture could ever attempt. Reused verbatim by tests that prove
 * the settings, and by callers that open the capture transaction themselves.
 */
export const MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG = Object.freeze({
  accessMode: 'read only',
  isolationLevel: 'repeatable read',
} as const)

/**
 * Families this capture can inventory, in contract order. Today every family
 * the snapshot contract knows is supported; the set exists so a future
 * contract family has a place to be declared unsupported — requested then, it
 * would stay unknown with reason `unsupported_family` instead of silently
 * reading as an empty capture.
 */
export const MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES: readonly MigrationSnapshotFamily[] =
  migrationSnapshotFamilies

/**
 * Rows fetched per family page. Each page asks for one extra row (the probe)
 * so exhaustion is observed directly; the probe row is never captured.
 */
export const MIGRATION_SNAPSHOT_CAPTURE_PAGE_SIZE = 500

/** Why a requested domain was not captured. */
export const migrationSnapshotCaptureUnknownReasons = [
  'unrecognized_domain',
  'unsupported_family',
] as const

export type MigrationSnapshotCaptureUnknownReason =
  (typeof migrationSnapshotCaptureUnknownReasons)[number]

/**
 * The capture outcome for one requested domain. `captured` domains have a
 * section in the document (possibly an empty one — a proven fact). `unknown`
 * domains have no section at all: the comparator will report that domain as
 * `unknown_domain`, never as zero.
 */
export type MigrationSnapshotDomainCaptureStatus = Readonly<{
  domain: string
  status: 'captured' | 'unknown'
  unknownReason: MigrationSnapshotCaptureUnknownReason | null
}>

/** Injectable capture identity and clock. Nothing here is derived at runtime. */
export type MigrationSnapshotCaptureIdentityInput = Readonly<{
  /** Derives time-observed record facts (invitation expiry). Never emitted. */
  capturedAt: Date
  rehearsalId: string
  snapshotId: string
  source: string
}>

export type MigrationSnapshotCaptureInput = Readonly<{
  identity: MigrationSnapshotCaptureIdentityInput
  /**
   * Per-family scan bound. A family that reaches the bound before exhausting
   * the domain is flagged `truncated` with this limit recorded. Must be a
   * safe integer in `[1, MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION]`;
   * defaults to the contract maximum.
   */
  limitPerFamily?: number
  /**
   * Domains to capture, by snapshot-family name. Omit to capture every
   * supported family. A name outside the support set yields an `unknown`
   * domain status with a typed reason — never an empty success.
   */
  requestedDomains?: readonly string[]
}>

export type MigrationSnapshotCaptureResult = Readonly<{
  document: MigrationSnapshotDocument
  domains: readonly MigrationSnapshotDomainCaptureStatus[]
}>

/**
 * Capture input violates its contract: blank identity fields, an invalid
 * clock, an out-of-range bound, or a non-string domain name. Thrown before
 * any database work starts.
 */
export class MigrationSnapshotCaptureInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationSnapshotCaptureInputError'
  }
}

// ─── Input validation and domain resolution ──────────────────────────────────

function requireCaptureIdentity(
  identity: MigrationSnapshotCaptureIdentityInput
): MigrationSnapshotIdentity {
  if (typeof identity !== 'object' || identity === null) {
    throw new MigrationSnapshotCaptureInputError('Capture identity must be an object')
  }
  const { capturedAt, rehearsalId, snapshotId, source } = identity
  if (typeof rehearsalId !== 'string' || rehearsalId.length === 0) {
    throw new MigrationSnapshotCaptureInputError('Capture identity rehearsalId must be non-empty')
  }
  if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
    throw new MigrationSnapshotCaptureInputError('Capture identity snapshotId must be non-empty')
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new MigrationSnapshotCaptureInputError('Capture identity source must be non-empty')
  }
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
    throw new MigrationSnapshotCaptureInputError('Capture identity capturedAt must be a valid Date')
  }
  return Object.freeze({
    formatVersion: MIGRATION_SNAPSHOT_FORMAT_VERSION,
    rehearsalId,
    snapshotId,
    source,
  })
}

function requireCaptureBound(value: number | undefined): number {
  const bound = value ?? MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION
  if (
    !Number.isSafeInteger(bound) ||
    bound < 1 ||
    bound > MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION
  ) {
    throw new MigrationSnapshotCaptureInputError(
      `limitPerFamily must be a safe integer between 1 and ${MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION}`
    )
  }
  return bound
}

/**
 * Resolve the requested domains into deterministic capture statuses, sorted by
 * domain name. Without an explicit request every supported family is
 * captured; names outside the support set stay unknown with a typed reason.
 * Duplicate names collapse to one status.
 */
export function resolveMigrationSnapshotCaptureDomains(
  requestedDomains: readonly string[] | undefined
): readonly MigrationSnapshotDomainCaptureStatus[] {
  const supported = new Set<string>(MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES)
  const names = requestedDomains ?? [...supported]
  const resolved = new Map<string, MigrationSnapshotDomainCaptureStatus>()
  for (const domain of names) {
    if (typeof domain !== 'string' || domain.length === 0) {
      throw new MigrationSnapshotCaptureInputError(
        'requestedDomains entries must be non-empty strings'
      )
    }
    if (resolved.has(domain)) continue
    if (supported.has(domain)) {
      resolved.set(domain, { domain, status: 'captured', unknownReason: null })
      continue
    }
    resolved.set(domain, {
      domain,
      status: 'unknown',
      unknownReason: isMigrationSnapshotFamily(domain)
        ? 'unsupported_family'
        : 'unrecognized_domain',
    })
  }
  return [...resolved.values()].toSorted((left, right) =>
    left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0
  )
}

// ─── Deterministic encodings ─────────────────────────────────────────────────

const PAYLOAD_CANONICAL_MAX_DEPTH = 64

/**
 * Deterministic JSON encoding for event payload digests: object keys sorted,
 * arrays positional, recursion depth-capped. The same payload always digests
 * the same, whatever key order the driver handed back.
 */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > PAYLOAD_CANONICAL_MAX_DEPTH) return '"~depth"'
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : `"~${String(value)}"`
    case 'boolean':
      return value ? 'true' : 'false'
    default: {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`
      }
      if (typeof value === 'object') {
        const source = value as Record<string, unknown>
        const entries = Object.keys(source)
          .toSorted()
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key], depth + 1)}`)
        return `{${entries.join(',')}}`
      }
      return `"~${typeof value}"`
    }
  }
}

/**
 * Caller-computed payload digest for one durable event: SHA-256 over the
 * canonical encoding of the event payload. The payload itself never travels —
 * this digest is what drift detection compares.
 */
export function migrationSnapshotEventPayloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')
}

// ─── Stable record identity (order only) ─────────────────────────────────────

/**
 * Escape one composite-key part. Mirrors the comparator's collision-safe
 * tuple encoding so capture orders records by exactly the identity the
 * comparator will use.
 */
function escapeKeyPart(part: string): string {
  return part.replaceAll('\\', '\\\\').replaceAll(':', '\\:')
}

function tupleKey(...parts: readonly (string | null)[]): string {
  const fields: string[] = []
  for (const part of parts) {
    if (part === null) {
      fields.push('0', '')
      continue
    }
    fields.push(escapeKeyPart(part))
  }
  return fields.join(':')
}

/** The comparator's stable identity for one record, per family. */
function stableIdOf(record: MigrationSnapshotRecord): string {
  switch (record.family) {
    case 'agents':
      return record.agentId
    case 'channelParticipants':
      return tupleKey(record.channelId, record.principalKind, record.principalId)
    case 'channels':
      return record.channelId
    case 'contentRefs':
      return record.contentRefId
    case 'events':
      return record.eventId
    case 'executionAttempts':
      return tupleKey(record.taskId, String(record.attempt))
    case 'identityBindings':
      return tupleKey(record.provider, record.subject)
    case 'invitations':
      return record.invitationId
    case 'memberships':
      return tupleKey(record.workspaceId, record.userId)
    case 'messages':
      return record.messageId
    case 'projectMembers':
      return tupleKey(record.projectId, record.userId)
    case 'projects':
      return record.projectId
    case 'readState':
      return tupleKey(
        record.workspaceId,
        record.userId,
        record.channelId,
        record.threadRootMessageId
      )
    case 'tasks':
      return record.taskId
    case 'temporarySessions':
      return record.sessionId
    case 'workspaces':
      return record.workspaceId
  }
}

/**
 * Plain code-unit sort over the comparator's stable identity: unique per
 * family, independent of database collation and page boundaries, so the same
 * rows always serialize in the same order.
 */
function byStableId(left: MigrationSnapshotRecord, right: MigrationSnapshotRecord): number {
  const leftId = stableIdOf(left)
  const rightId = stableIdOf(right)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

// ─── Bounded pagination ──────────────────────────────────────────────────────

export type BoundedCollection = Readonly<{
  records: MigrationSnapshotRecord[]
  truncated: boolean
}>

/**
 * Read one family through offset pagination until the domain is exhausted or
 * `limit` records are captured — whichever happens first — and report which.
 * Each page asks for `MIGRATION_SNAPSHOT_CAPTURE_PAGE_SIZE + 1` rows; the
 * extra row proves more data follows without a second query. Truncation is
 * reported as `true` exactly when the scan stopped at the bound while rows
 * remained (in the page's tail or beyond it); an exhausted scan is `false`
 * even when it filled the bound exactly. Records are ordered by stable id so
 * page size and collation cannot change the output.
 */
export async function collectBoundedRecords<R>(input: {
  fetchPage: (offset: number, rowsBound: number) => Promise<readonly R[]>
  limit: number
  toRecord: (row: R) => MigrationSnapshotRecord
}): Promise<BoundedCollection> {
  const { fetchPage, toRecord } = input
  const limit = requireCaptureBound(input.limit)
  const records: MigrationSnapshotRecord[] = []
  let offset = 0
  for (;;) {
    const probed = await fetchPage(offset, MIGRATION_SNAPSHOT_CAPTURE_PAGE_SIZE + 1)
    const hasMore = probed.length > MIGRATION_SNAPSHOT_CAPTURE_PAGE_SIZE
    const page = hasMore ? probed.slice(0, MIGRATION_SNAPSHOT_CAPTURE_PAGE_SIZE) : probed
    let consumed = 0
    for (; consumed < page.length; consumed++) {
      if (records.length >= limit) break
      records.push(toRecord(page[consumed]))
    }
    if (records.length >= limit) {
      const stoppedMidPage = consumed < page.length
      return { records: records.toSorted(byStableId), truncated: stoppedMidPage || hasMore }
    }
    if (!hasMore) return { records: records.toSorted(byStableId), truncated: false }
    offset += page.length
  }
}

async function captureFamilySection<R>(
  transaction: AgentHqTransaction,
  bound: number,
  reader: Readonly<{
    fetchPage: (offset: number, rowsBound: number) => Promise<readonly R[]>
    toRecord: (row: R) => MigrationSnapshotRecord
  }>
): Promise<MigrationSnapshotSection> {
  const { records, truncated } = await collectBoundedRecords({
    fetchPage: reader.fetchPage,
    limit: bound,
    toRecord: reader.toRecord,
  })
  return Object.freeze({
    limit: bound,
    records: Object.freeze(records),
    truncated,
  })
}

// ─── Per-family readers ──────────────────────────────────────────────────────

/**
 * The invitation lifecycle state, derived exactly as
 * `workspace-invitations.ts` derives it — from the row's settled timestamps
 * and the injectable capture clock, never the wall clock, so the same rows
 * and the same `capturedAt` derive the same state.
 */
function invitationState(
  row: Readonly<{
    acceptedAt: Date | null
    expiresAt: Date
    revokedAt: Date | null
  }>,
  now: Date
): 'accepted' | 'expired' | 'pending' | 'revoked' {
  if (row.acceptedAt) return 'accepted'
  if (row.revokedAt) return 'revoked'
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending'
}

/**
 * A bigint that reached the capture through a raw query (the read-frontier
 * union) as a driver string. Safe integers become numbers; anything else
 * stays a string so the record serializes deterministically and the
 * comparator quarantines it as a typed limit issue — never rounded silently.
 */
function countFromDriver(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
    return value
  }
  return String(value)
}

type RawRow = Record<string, unknown>

async function rawRows(
  transaction: AgentHqTransaction,
  query: ReturnType<typeof sql>
): Promise<readonly RawRow[]> {
  return (await transaction.execute(query)) as unknown as readonly RawRow[]
}

/**
 * Channel-level and thread-level read frontiers as one paginated stream: the
 * union of both tables with a null thread root for channel rows, ordered by
 * the comparator's read-state identity (nulls last, deterministic).
 */
function readStateSection(
  transaction: AgentHqTransaction,
  bound: number
): Promise<MigrationSnapshotSection> {
  return captureFamilySection(transaction, bound, {
    fetchPage: async (offset, rowsBound) =>
      rawRows(
        transaction,
        sql`
          select
            frontiers.workspace_id as workspace_id,
            frontiers.user_id as user_id,
            frontiers.channel_id as channel_id,
            frontiers.thread_root_message_id as thread_root_message_id,
            frontiers.last_read_sequence as last_read_sequence,
            frontiers.manually_unread as manually_unread
          from (
            select
              ${channelReadStates.workspaceId},
              ${channelReadStates.userId},
              ${channelReadStates.channelId},
              null::uuid as thread_root_message_id,
              ${channelReadStates.lastReadSequence},
              ${channelReadStates.manuallyUnread}
            from ${channelReadStates}
            union all
            select
              ${threadReadStates.workspaceId},
              ${threadReadStates.userId},
              ${threadReadStates.channelId},
              ${threadReadStates.threadRootMessageId},
              ${threadReadStates.lastReadSequence},
              ${threadReadStates.manuallyUnread}
            from ${threadReadStates}
          ) frontiers
          order by
            frontiers.workspace_id,
            frontiers.user_id,
            frontiers.channel_id,
            frontiers.thread_root_message_id
          limit ${rowsBound} offset ${offset}
        `
      ),
    toRecord: (row) =>
      // `lastReadSequence` arrives through a raw query as a driver string; a
      // value that is not a safe non-negative integer stays a string so the
      // record serializes deterministically and the comparator quarantines it
      // as a typed limit issue — never rounded silently.
      ({
        channelId: row.channel_id as string,
        family: 'readState',
        lastReadSequence: countFromDriver(row.last_read_sequence),
        manuallyUnread: row.manually_unread === true,
        threadRootMessageId: (row.thread_root_message_id as string | null) ?? null,
        userId: row.user_id as string,
        workspaceId: row.workspace_id as string,
      }) as MigrationSnapshotRecordFor<'readState'>,
  })
}

async function captureFamilySectionByName(
  transaction: AgentHqTransaction,
  family: MigrationSnapshotFamily,
  bound: number,
  capturedAt: Date
): Promise<MigrationSnapshotSection> {
  switch (family) {
    case 'agents':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              id: agents.id,
              lifecycleState: agents.lifecycleState,
              projectId: agents.projectId,
              workspaceId: agents.workspaceId,
            })
            .from(agents)
            .orderBy(asc(agents.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          agentId: row.id,
          family: 'agents',
          lifecycleState: row.lifecycleState,
          projectId: row.projectId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'channelParticipants':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              agentId: channelParticipants.agentId,
              channelId: channelParticipants.channelId,
              principalKind: channelParticipants.principalKind,
              userId: channelParticipants.userId,
              workspaceId: channelParticipants.workspaceId,
            })
            .from(channelParticipants)
            .orderBy(
              asc(channelParticipants.channelId),
              asc(channelParticipants.principalKind),
              asc(channelParticipants.userId),
              asc(channelParticipants.agentId)
            )
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) =>
          // A principal id can only be null on a row that already violates the
          // schema's principal-consistency check; the record is carried verbatim
          // so the comparator quarantines it as a typed issue instead of capture
          // guessing or dropping it.
          ({
            channelId: row.channelId,
            family: 'channelParticipants',
            principalId: row.userId ?? row.agentId,
            principalKind: row.principalKind,
            workspaceId: row.workspaceId,
          }) as MigrationSnapshotRecordFor<'channelParticipants'>,
      })
    case 'channels':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              id: channels.id,
              projectId: channels.projectId,
              visibility: channels.visibility,
              workspaceId: channels.workspaceId,
            })
            .from(channels)
            .orderBy(asc(channels.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          channelId: row.id,
          family: 'channels',
          projectId: row.projectId,
          visibility: row.visibility,
          workspaceId: row.workspaceId,
        }),
      })
    case 'contentRefs':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              availability: contentRefs.availability,
              digestSha256: contentRefs.digestSha256,
              id: contentRefs.id,
              keyVersion: contentRefs.keyVersion,
              messageId: contentRefs.messageId,
              revision: contentRefs.revision,
              taskId: contentRefs.taskId,
              workspaceId: contentRefs.workspaceId,
            })
            .from(contentRefs)
            .orderBy(asc(contentRefs.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          availability: row.availability,
          contentRefId: row.id,
          digestSha256: row.digestSha256,
          family: 'contentRefs',
          keyVersion: row.keyVersion,
          messageId: row.messageId,
          revision: row.revision,
          taskId: row.taskId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'events':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              eventType: workspaceEvents.eventType,
              id: workspaceEvents.id,
              payload: workspaceEvents.payload,
              schemaVersion: workspaceEvents.schemaVersion,
              workspaceId: workspaceEvents.workspaceId,
              workspaceSequence: workspaceEvents.workspaceSequence,
            })
            .from(workspaceEvents)
            .orderBy(asc(workspaceEvents.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          eventId: row.id,
          eventType: row.eventType,
          family: 'events',
          payloadDigest: migrationSnapshotEventPayloadDigest(row.payload),
          schemaVersion: row.schemaVersion,
          workspaceId: row.workspaceId,
          workspaceSequence: row.workspaceSequence,
        }),
      })
    case 'executionAttempts':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              attempt: taskExecutionAttempts.attempt,
              locationKind: taskExecutionAttempts.locationKind,
              runtimeNodeId: taskExecutionAttempts.runtimeNodeId,
              taskId: taskExecutionAttempts.taskId,
              workspaceId: taskExecutionAttempts.workspaceId,
            })
            .from(taskExecutionAttempts)
            .orderBy(asc(taskExecutionAttempts.taskId), asc(taskExecutionAttempts.attempt))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          attempt: row.attempt,
          family: 'executionAttempts',
          locationKind: row.locationKind,
          runtimeNodeId: row.runtimeNodeId,
          taskId: row.taskId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'identityBindings':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              provider: authIdentities.provider,
              subject: authIdentities.subject,
              userId: authIdentities.userId,
            })
            .from(authIdentities)
            .orderBy(asc(authIdentities.provider), asc(authIdentities.subject))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'identityBindings',
          provider: row.provider,
          subject: row.subject,
          userId: row.userId,
        }),
      })
    case 'invitations':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              acceptedAt: workspaceInvitations.acceptedAt,
              expiresAt: workspaceInvitations.expiresAt,
              id: workspaceInvitations.id,
              invitedByUserId: workspaceInvitations.invitedByUserId,
              revokedAt: workspaceInvitations.revokedAt,
              role: workspaceInvitations.role,
              workspaceId: workspaceInvitations.workspaceId,
            })
            .from(workspaceInvitations)
            .orderBy(asc(workspaceInvitations.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'invitations',
          invitationId: row.id,
          invitedByUserId: row.invitedByUserId,
          role: row.role,
          state: invitationState(row, capturedAt),
          workspaceId: row.workspaceId,
        }),
      })
    case 'memberships':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              role: workspaceMemberships.role,
              userId: workspaceMemberships.userId,
              workspaceId: workspaceMemberships.workspaceId,
            })
            .from(workspaceMemberships)
            .orderBy(asc(workspaceMemberships.workspaceId), asc(workspaceMemberships.userId))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'memberships',
          role: row.role,
          userId: row.userId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'messages':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              channelId: messages.channelId,
              deletedAt: messages.deletedAt,
              id: messages.id,
              threadRootMessageId: messages.threadRootMessageId,
              workspaceId: messages.workspaceId,
            })
            .from(messages)
            .orderBy(asc(messages.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          channelId: row.channelId,
          deleted: row.deletedAt !== null,
          family: 'messages',
          messageId: row.id,
          threadRootMessageId: row.threadRootMessageId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'projectMembers':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              projectId: projectMembers.projectId,
              role: projectMembers.role,
              userId: projectMembers.userId,
              workspaceId: projectMembers.workspaceId,
            })
            .from(projectMembers)
            .orderBy(asc(projectMembers.projectId), asc(projectMembers.userId))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'projectMembers',
          projectId: row.projectId,
          role: row.role,
          userId: row.userId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'projects':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              id: projects.id,
              visibility: projects.visibility,
              workspaceId: projects.workspaceId,
            })
            .from(projects)
            .orderBy(asc(projects.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'projects',
          projectId: row.id,
          visibility: row.visibility,
          workspaceId: row.workspaceId,
        }),
      })
    case 'readState':
      return readStateSection(transaction, bound)
    case 'tasks':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              channelId: tasks.channelId,
              creatorUserId: tasks.creatorUserId,
              id: tasks.id,
              lifecycleState: tasks.lifecycleState,
              messageId: tasks.messageId,
              projectId: tasks.projectId,
              threadRootMessageId: tasks.threadRootMessageId,
              version: tasks.version,
              workspaceId: tasks.workspaceId,
            })
            .from(tasks)
            .orderBy(asc(tasks.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          channelId: row.channelId,
          creatorUserId: row.creatorUserId,
          family: 'tasks',
          lifecycleState: row.lifecycleState,
          messageId: row.messageId,
          projectId: row.projectId,
          taskId: row.id,
          threadRootMessageId: row.threadRootMessageId,
          version: row.version,
          workspaceId: row.workspaceId,
        }),
      })
    case 'temporarySessions':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              claimedAt: temporaryUserSessions.claimedAt,
              id: temporaryUserSessions.id,
              userId: temporaryUserSessions.userId,
            })
            .from(temporaryUserSessions)
            .orderBy(asc(temporaryUserSessions.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          claimed: row.claimedAt !== null,
          family: 'temporarySessions',
          sessionId: row.id,
          userId: row.userId,
        }),
      })
    case 'workspaces':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              controlPlaneWorkspaceId: workspaces.controlPlaneWorkspaceId,
              deletedAt: workspaces.deletedAt,
              id: workspaces.id,
              ownerUserId: workspaces.ownerUserId,
            })
            .from(workspaces)
            .orderBy(asc(workspaces.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          archived: row.deletedAt !== null,
          controlPlaneWorkspaceId: row.controlPlaneWorkspaceId,
          family: 'workspaces',
          ownerUserId: row.ownerUserId,
          workspaceId: row.id,
        }),
      })
  }
}

async function captureDocument(
  transaction: AgentHqTransaction,
  identity: MigrationSnapshotIdentity,
  domains: readonly MigrationSnapshotDomainCaptureStatus[],
  bound: number,
  capturedAt: Date
): Promise<MigrationSnapshotDocument> {
  const captured = new Set(
    domains.filter((domain) => domain.status === 'captured').map((domain) => domain.domain)
  )
  // Sections are emitted in contract-family order regardless of the order
  // domains were requested in, so the serialized document is byte-stable.
  const sections: Partial<Record<MigrationSnapshotFamily, MigrationSnapshotSection>> = {}
  for (const family of migrationSnapshotFamilies) {
    if (!captured.has(family)) continue
    sections[family] = await captureFamilySectionByName(transaction, family, bound, capturedAt)
  }
  return Object.freeze({
    identity,
    sections: Object.freeze(sections) as MigrationSnapshotSections,
  })
}

/**
 * Capture one consistent snapshot document inside the caller's transaction.
 * The caller owns the transaction's isolation and access mode — wrap it in
 * `MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG` (or open it with
 * `captureMigrationSnapshot`) so every family is read at one database
 * snapshot and the read stays read-only.
 */
export async function captureMigrationSnapshotInTransaction(
  transaction: AgentHqTransaction,
  input: MigrationSnapshotCaptureInput
): Promise<MigrationSnapshotCaptureResult> {
  const identity = requireCaptureIdentity(input.identity)
  const domains = resolveMigrationSnapshotCaptureDomains(input.requestedDomains)
  const bound = requireCaptureBound(input.limitPerFamily)
  const document = await captureDocument(
    transaction,
    identity,
    domains,
    bound,
    input.identity.capturedAt
  )
  return Object.freeze({ document, domains })
}

/**
 * Capture one consistent, read-only snapshot document from the database.
 *
 * Opens exactly one REPEATABLE READ, READ ONLY transaction (see
 * `MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG`) and reads every requested
 * family inside it, offset-paginated to exhaustion or the per-family bound.
 * The database handle is an explicit argument; nothing here resolves a DSN,
 * writes a row, or derives any output value from the wall clock — identity
 * and the capture time arrive in `input`, and the same database state with
 * the same inputs produces byte-identical documents.
 */
export async function captureMigrationSnapshot(
  database: AgentHqDatabase,
  input: MigrationSnapshotCaptureInput
): Promise<MigrationSnapshotCaptureResult> {
  const identity = requireCaptureIdentity(input.identity)
  const domains = resolveMigrationSnapshotCaptureDomains(input.requestedDomains)
  const bound = requireCaptureBound(input.limitPerFamily)
  const document = await database.transaction(
    (transaction) =>
      captureDocument(transaction, identity, domains, bound, input.identity.capturedAt),
    MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG
  )
  return Object.freeze({ document, domains })
}
