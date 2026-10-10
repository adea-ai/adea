import type { RuntimeNodePrincipalRef, UserPrincipalRef } from '@adea-ai/types'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { requireEligibleRuntimeNode, RuntimeNodeError } from './runtime-nodes'
import {
  artifactReferenceGrants,
  artifacts,
  retentionCleanupReceipts,
  retentionDeletionAuthorizations,
  retentionHolds,
  runtimeNodeKeys,
  runtimeNodes,
  workspaceMemberships,
  workspaces,
} from './schema'
import {
  evaluateRetentionDeletion,
  RETENTION_CATEGORIES,
  recordCleanupReceipt,
  RetentionPolicyError,
  UNSET_RETENTION_PERIODS,
  type CleanupReceipt,
  type RetentionAuthorization,
  type RetentionCategory,
  type RetentionDecision,
  type RetentionHold,
  type RetentionPeriods,
  type TrustedCleanupExecutor,
} from './retention-policy'

/**
 * Durable composition of the retention gate (M18.02, #1221).
 *
 * `retention-policy` decides; this module supplies the authoritative inputs
 * from PostgreSQL and runs the decision under locks, so a decision reflects one
 * consistent instant. It stores nothing that deletes data, schedules nothing,
 * and never reads retention periods from a default: callers pass periods, and
 * `UNSET_RETENTION_PERIODS` refuses every deletion.
 *
 * Authority and identity come from existing contracts:
 *
 * - Actors are `UserPrincipalRef`s. Granting or revoking deletion authority,
 *   and placing or releasing holds, requires an owner or admin of a live
 *   workspace at the time of the act, checked against membership rows that
 *   are share-locked for the transaction.
 * - Executors are runtime nodes. A receipt is accepted only from a node that
 *   `requireEligibleRuntimeNode` accepts now (paired, with an active verified
 *   signing key). The receipt's claimed executor must equal the authenticated
 *   node. The pure gate then applies the executor's authorized window and
 *   revocation to each receipt.
 * - Active references for artifacts are the live rows of
 *   `artifact_reference_grants` (unrevoked, not expired at the database clock).
 *
 * Time comes from the database clock (`clock_timestamp()`), not the process.
 * Every operation for one subject takes the same transaction-scoped advisory
 * lock, so grant, revoke, hold, receipt, and gate are serialized per subject.
 * Artifact gates lock the artifact row first, in the same order the grant
 * registration path uses (artifact, then grant), so no lock cycle is possible.
 */

/** Stands in for an absent authority in the pure gate: a generation id no stored receipt carries. */
const NO_AUTHORITY = 'no-authority'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const retentionCleanupErrorCodes = [
  'authority_unavailable',
  'authorization_conflict',
  'authorization_not_current',
  'authorization_not_found',
  'hold_not_found',
  'invalid_input',
  'receipt_conflict',
  'receipt_outside_window',
  'receipt_request_mismatch',
  'receipt_untrusted',
] as const

export type RetentionCleanupErrorCode = (typeof retentionCleanupErrorCodes)[number]

/** Typed refusal. The message is the code only: no subject, actor, or payload. */
export class RetentionCleanupError extends Error {
  constructor(readonly code: RetentionCleanupErrorCode) {
    super(code)
    this.name = 'RetentionCleanupError'
  }
}

function reject(code: RetentionCleanupErrorCode): never {
  throw new RetentionCleanupError(code)
}

type Database = AgentHqDatabase | AgentHqTransaction

export type RetentionAuthorizationRecord = Readonly<{
  category: RetentionCategory
  expiresAt: string
  grantedAt: string
  id: string
  revokedAt: string | null
  subjectId: string
  workspaceId: string
}>

export type RetentionHoldRecord = Readonly<{
  category: RetentionCategory
  id: string
  releasedAt: string | null
  subjectId: string
  workspaceId: string
}>

export type StoredCleanupReceiptRecord = Readonly<{
  category: RetentionCategory
  coverage: CleanupReceipt['coverage']
  executorSigningFingerprint: string
  id: string
  idempotencyKey: string
  observedAt: string
  operation: CleanupReceipt['operation']
  outcome: CleanupReceipt['outcome']
  residualCount: number
  runtimeNodeId: string
  subjectId: string
  workspaceId: string
}>

function validateScope(workspaceId: string, category: string, subjectId: string): void {
  if (!UUID.test(workspaceId)) reject('invalid_input')
  if (!(RETENTION_CATEGORIES as readonly string[]).includes(category)) reject('invalid_input')
  if (typeof subjectId !== 'string' || subjectId.length < 1 || subjectId.length > 128)
    reject('invalid_input')
  if (subjectId.trim() !== subjectId) reject('invalid_input')
  if (category === 'artifacts' && !UUID.test(subjectId)) reject('invalid_input')
}

function timestampMs(value: string): number {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) reject('invalid_input')
  return ms
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

async function databaseNowMs(transaction: AgentHqTransaction): Promise<number> {
  const rows = await transaction.execute(
    sql`select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms`
  )
  const ms = Number((rows[0] as { ms?: unknown } | undefined)?.ms)
  if (!Number.isFinite(ms)) throw new Error('database clock unavailable')
  return ms
}

/** One transaction-scoped advisory lock per (workspace, category, subject). */
async function lockSubject(
  transaction: AgentHqTransaction,
  workspaceId: string,
  category: string,
  subjectId: string
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`retention:${workspaceId}:${category}:${subjectId}`}, 0))`
  )
}

/** Owner or admin of a live workspace, share-locked for the act. */
async function requireAuthority(
  transaction: AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<void> {
  const [row] = await transaction
    .select({ deletedAt: workspaces.deletedAt, role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
    .for('share')
  if (!row || row.deletedAt !== null) reject('authority_unavailable')
  if (row.role !== 'owner' && row.role !== 'admin') reject('authority_unavailable')
}

async function lockArtifactRow(
  transaction: AgentHqTransaction,
  workspaceId: string,
  artifactId: string
): Promise<void> {
  await transaction
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, workspaceId)))
    .limit(1)
    .for('update')
}

type AuthorizationRow = typeof retentionDeletionAuthorizations.$inferSelect

function authorizationRecord(row: AuthorizationRow): RetentionAuthorizationRecord {
  return Object.freeze({
    category: row.category,
    expiresAt: row.expiresAt.toISOString(),
    grantedAt: row.grantedAt.toISOString(),
    id: row.id,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    subjectId: row.subjectId,
    workspaceId: row.workspaceId,
  })
}

async function liveAuthorization(
  transaction: Database,
  workspaceId: string,
  category: string,
  subjectId: string
): Promise<AuthorizationRow | undefined> {
  const [row] = await transaction
    .select()
    .from(retentionDeletionAuthorizations)
    .where(
      and(
        eq(retentionDeletionAuthorizations.workspaceId, workspaceId),
        eq(retentionDeletionAuthorizations.category, category as RetentionCategory),
        eq(retentionDeletionAuthorizations.subjectId, subjectId),
        isNull(retentionDeletionAuthorizations.revokedAt)
      )
    )
    .limit(1)
  return row
}

/**
 * Executors this workspace can trust right now: a node with an active verified
 * signing key, judged by the pure gate's window and revocation rules. A node
 * without that key is absent, so its receipts never count.
 */
async function trustedExecutorsFor(
  transaction: AgentHqTransaction,
  workspaceId: string,
  runtimeNodeIds: readonly string[]
): Promise<Map<string, TrustedCleanupExecutor>> {
  const executors = new Map<string, TrustedCleanupExecutor>()
  const ids = [...new Set(runtimeNodeIds)]
  if (ids.length === 0) return executors
  const nodes = await transaction
    .select({
      createdAt: runtimeNodes.createdAt,
      id: runtimeNodes.id,
      revokedAt: runtimeNodes.revokedAt,
    })
    .from(runtimeNodes)
    .where(and(eq(runtimeNodes.workspaceId, workspaceId), inArray(runtimeNodes.id, ids)))
  const withSigningKey = new Set(
    (
      await transaction
        .select({ runtimeNodeId: runtimeNodeKeys.runtimeNodeId })
        .from(runtimeNodeKeys)
        .where(
          and(
            inArray(runtimeNodeKeys.runtimeNodeId, ids),
            eq(runtimeNodeKeys.role, 'signing'),
            isNull(runtimeNodeKeys.retiredAt),
            isNotNull(runtimeNodeKeys.verifiedAt)
          )
        )
    ).map((row) => row.runtimeNodeId)
  )
  for (const node of nodes) {
    if (!withSigningKey.has(node.id)) continue
    executors.set(node.id, {
      authorizedFrom: node.createdAt.toISOString(),
      authorizedUntil: null,
      revokedAt: node.revokedAt?.toISOString() ?? null,
    })
  }
  return executors
}

/** Active references from other workspaces, read under the subject lock. Expiry is judged at the decision instant. */
async function activeArtifactReferenceRows(
  transaction: AgentHqTransaction,
  workspaceId: string,
  category: string,
  subjectId: string
): Promise<Array<{ expiresAt: string | null }>> {
  if (category !== 'artifacts') return []
  return transaction
    .select({ expiresAt: artifactReferenceGrants.expiresAt })
    .from(artifactReferenceGrants)
    .where(
      and(
        eq(artifactReferenceGrants.sourceWorkspaceId, workspaceId),
        eq(artifactReferenceGrants.artifactId, subjectId),
        isNull(artifactReferenceGrants.revokedAt)
      )
    )
}

/** Live references at `nowMs`. Fail closed: an expiry that cannot be read is still live. */
function liveReferenceCount(rows: readonly { expiresAt: string | null }[], nowMs: number): number {
  return rows.filter((row) => row.expiresAt === null || !(Date.parse(row.expiresAt) <= nowMs))
    .length
}

function holdRecord(row: typeof retentionHolds.$inferSelect): RetentionHoldRecord {
  return Object.freeze({
    category: row.category,
    id: row.id,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    subjectId: row.subjectId,
    workspaceId: row.workspaceId,
  })
}

/**
 * Authority to delete one subject: owner or admin of its workspace grants it
 * with a fixed expiry, and at most one unrevoked grant exists per subject.
 * Authority is judged after the subject lock, so a waiting admin cannot act on
 * a membership that ended while it waited.
 */
export async function grantRetentionDeletionAuthorization(
  database: AgentHqDatabase,
  input: Readonly<{
    actor: UserPrincipalRef
    category: RetentionCategory
    expiresAt: string
    subjectId: string
    workspaceId: string
  }>
): Promise<RetentionAuthorizationRecord> {
  validateScope(input.workspaceId, input.category, input.subjectId)
  const expiresMs = timestampMs(input.expiresAt)
  return database.transaction(async (transaction) => {
    await lockSubject(transaction, input.workspaceId, input.category, input.subjectId)
    await requireAuthority(transaction, input.workspaceId, input.actor)
    const existing = await liveAuthorization(
      transaction,
      input.workspaceId,
      input.category,
      input.subjectId
    )
    const nowMs = await databaseNowMs(transaction)
    if (expiresMs <= nowMs) reject('invalid_input')
    if (existing) reject('authorization_conflict')
    const [row] = await transaction
      .insert(retentionDeletionAuthorizations)
      .values({
        category: input.category,
        expiresAt: new Date(expiresMs),
        grantedAt: new Date(nowMs),
        grantedByUserId: input.actor.userId,
        subjectId: input.subjectId,
        workspaceId: input.workspaceId,
      })
      .returning()
    return authorizationRecord(row!)
  })
}

/** Absolute revocation of one authority row by a current owner or admin. */
export async function revokeRetentionDeletionAuthorization(
  database: AgentHqDatabase,
  input: Readonly<{ actor: UserPrincipalRef; authorizationId: string; workspaceId: string }>
): Promise<RetentionAuthorizationRecord> {
  if (!UUID.test(input.workspaceId) || !UUID.test(input.authorizationId)) reject('invalid_input')
  return database.transaction(async (transaction) => {
    // A pre-check, so an actor without authority learns nothing about the target.
    await requireAuthority(transaction, input.workspaceId, input.actor)
    const [target] = await transaction
      .select({
        category: retentionDeletionAuthorizations.category,
        subjectId: retentionDeletionAuthorizations.subjectId,
      })
      .from(retentionDeletionAuthorizations)
      .where(
        and(
          eq(retentionDeletionAuthorizations.id, input.authorizationId),
          eq(retentionDeletionAuthorizations.workspaceId, input.workspaceId)
        )
      )
      .limit(1)
    if (!target) reject('authorization_not_found')
    await lockSubject(transaction, input.workspaceId, target.category, target.subjectId)
    // Judged again at the decision: the membership may have changed while waiting for the lock.
    await requireAuthority(transaction, input.workspaceId, input.actor)
    const nowMs = await databaseNowMs(transaction)
    const [row] = await transaction
      .update(retentionDeletionAuthorizations)
      .set({ revokedAt: new Date(nowMs), revokedByUserId: input.actor.userId })
      .where(
        and(
          eq(retentionDeletionAuthorizations.id, input.authorizationId),
          eq(retentionDeletionAuthorizations.workspaceId, input.workspaceId),
          isNull(retentionDeletionAuthorizations.revokedAt)
        )
      )
      .returning()
    if (!row) reject('authorization_not_found')
    return authorizationRecord(row)
  })
}

/** Place a legal or security hold. Owner or admin only, judged after the subject lock. */
export async function placeRetentionHold(
  database: AgentHqDatabase,
  input: Readonly<{
    actor: UserPrincipalRef
    category: RetentionCategory
    subjectId: string
    workspaceId: string
  }>
): Promise<RetentionHoldRecord> {
  validateScope(input.workspaceId, input.category, input.subjectId)
  return database.transaction(async (transaction) => {
    await lockSubject(transaction, input.workspaceId, input.category, input.subjectId)
    await requireAuthority(transaction, input.workspaceId, input.actor)
    const [row] = await transaction
      .insert(retentionHolds)
      .values({
        category: input.category,
        placedByUserId: input.actor.userId,
        subjectId: input.subjectId,
        workspaceId: input.workspaceId,
      })
      .returning()
    return holdRecord(row!)
  })
}

/** Release a hold. Owner or admin only; a released hold stays on record. */
export async function releaseRetentionHold(
  database: AgentHqDatabase,
  input: Readonly<{ actor: UserPrincipalRef; holdId: string; workspaceId: string }>
): Promise<RetentionHoldRecord> {
  if (!UUID.test(input.workspaceId) || !UUID.test(input.holdId)) reject('invalid_input')
  return database.transaction(async (transaction) => {
    await requireAuthority(transaction, input.workspaceId, input.actor)
    const [target] = await transaction
      .select({ category: retentionHolds.category, subjectId: retentionHolds.subjectId })
      .from(retentionHolds)
      .where(
        and(eq(retentionHolds.id, input.holdId), eq(retentionHolds.workspaceId, input.workspaceId))
      )
      .limit(1)
    if (!target) reject('hold_not_found')
    await lockSubject(transaction, input.workspaceId, target.category, target.subjectId)
    await requireAuthority(transaction, input.workspaceId, input.actor)
    const nowMs = await databaseNowMs(transaction)
    const [row] = await transaction
      .update(retentionHolds)
      .set({ releasedAt: new Date(nowMs), releasedByUserId: input.actor.userId })
      .where(
        and(
          eq(retentionHolds.id, input.holdId),
          eq(retentionHolds.workspaceId, input.workspaceId),
          isNull(retentionHolds.releasedAt)
        )
      )
      .returning()
    if (!row) reject('hold_not_found')
    return holdRecord(row)
  })
}

export type StoredCleanupReceiptInput = Readonly<{
  category: RetentionCategory
  executor: RuntimeNodePrincipalRef
  /** A `CleanupReceipt` payload. Its `executorId`, if present, must be the executor. */
  idempotencyKey: string
  receipt: unknown
  workspaceId: string
}>

/**
 * Record one cleanup receipt from the authenticated executor node. A repeated
 * delivery with the same idempotency key and the same payload replays the
 * stored row. The same key with a different payload conflicts. A new receipt
 * requires current deletion authority for its subject.
 */
export async function recordRetentionCleanupReceipt(
  database: AgentHqDatabase,
  input: StoredCleanupReceiptInput
): Promise<Readonly<{ outcome: 'recorded' | 'replayed'; receipt: StoredCleanupReceiptRecord }>> {
  if (!UUID.test(input.workspaceId)) reject('invalid_input')
  if (input.executor.kind !== 'runtime_node' || !UUID.test(input.executor.runtimeNodeId))
    reject('receipt_untrusted')
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.trim() !== input.idempotencyKey ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 128
  )
    reject('invalid_input')
  if (!(RETENTION_CATEGORIES as readonly string[]).includes(input.category)) reject('invalid_input')
  const executorId = input.executor.runtimeNodeId
  if (typeof input.receipt !== 'object' || input.receipt === null) reject('invalid_input')
  const payload = input.receipt as Record<string, unknown>
  if (payload.executorId !== undefined && payload.executorId !== executorId)
    reject('receipt_untrusted')
  if (typeof payload.subjectId !== 'string') reject('invalid_input')
  const subjectId = payload.subjectId
  validateScope(input.workspaceId, input.category, subjectId)
  // Request identity is explicit and never synthesized. The receipt must name its
  // category, and the live request it answers, in its payload. A missing or
  // different value is refused, so a late receipt cannot be relabeled as a newer
  // generation.
  if (payload.category !== input.category) reject('receipt_request_mismatch')

  return database.transaction(async (transaction) => {
    // Lock first. Every read below is ordered by the subject lock, and a receipt
    // that waited for it is judged at admission, not at arrival.
    await lockSubject(transaction, input.workspaceId, input.category, subjectId)
    let eligible: Awaited<ReturnType<typeof requireEligibleRuntimeNode>>
    try {
      eligible = await requireEligibleRuntimeNode(transaction, input.workspaceId, executorId)
    } catch (error) {
      if (error instanceof RuntimeNodeError) reject('receipt_untrusted')
      throw error
    }
    // Evidence binds to the live deletion generation, never to the subject alone.
    const authority = await liveAuthorization(
      transaction,
      input.workspaceId,
      input.category,
      subjectId
    )
    if (!authority) reject('authorization_not_current')
    if (payload.requestId !== authority.id) reject('receipt_request_mismatch')
    const executors = await trustedExecutorsFor(transaction, input.workspaceId, [executorId])
    // The decision instant: sampled after the lock and every read above.
    const nowMs = await databaseNowMs(transaction)
    if (authority.expiresAt.getTime() <= nowMs) reject('authorization_not_current')
    let receipt: CleanupReceipt
    try {
      receipt = recordCleanupReceipt({ ...payload, executorId }, executors, iso(nowMs))
    } catch (error) {
      if (error instanceof RetentionPolicyError) {
        if (error.code === 'untrusted_executor') reject('receipt_untrusted')
        if (error.code === 'future_receipt') reject('receipt_outside_window')
        reject('invalid_input')
      }
      throw error
    }
    // Observed before this generation was granted: the executor is answering an earlier request.
    if (Date.parse(receipt.observedAt) < authority.grantedAt.getTime())
      reject('receipt_outside_window')

    const [existing] = await transaction
      .select()
      .from(retentionCleanupReceipts)
      .where(
        and(
          eq(retentionCleanupReceipts.workspaceId, input.workspaceId),
          eq(retentionCleanupReceipts.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1)
    if (existing) {
      const same =
        existing.category === input.category &&
        existing.subjectId === receipt.subjectId &&
        existing.authorizationId === authority.id &&
        existing.coverage === receipt.coverage &&
        existing.operation === receipt.operation &&
        existing.outcome === receipt.outcome &&
        existing.residualCount === receipt.residualCount &&
        existing.observedAt.getTime() === Date.parse(receipt.observedAt) &&
        existing.runtimeNodeId === executorId
      if (!same) reject('receipt_conflict')
      return { outcome: 'replayed', receipt: receiptRecord(existing) }
    }

    const [row] = await transaction
      .insert(retentionCleanupReceipts)
      .values({
        authorizationId: authority.id,
        category: input.category,
        coverage: receipt.coverage,
        executorSigningFingerprint: eligible.signingKeyFingerprint,
        idempotencyKey: input.idempotencyKey,
        observedAt: new Date(Date.parse(receipt.observedAt)),
        operation: receipt.operation,
        outcome: receipt.outcome,
        residualCount: receipt.residualCount,
        runtimeNodeId: executorId,
        subjectId: receipt.subjectId,
        workspaceId: input.workspaceId,
      })
      .returning()
    return { outcome: 'recorded', receipt: receiptRecord(row!) }
  })
}

function receiptRecord(
  row: typeof retentionCleanupReceipts.$inferSelect
): StoredCleanupReceiptRecord {
  return Object.freeze({
    category: row.category,
    coverage: row.coverage,
    executorSigningFingerprint: row.executorSigningFingerprint,
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    observedAt: row.observedAt.toISOString(),
    operation: row.operation,
    outcome: row.outcome,
    residualCount: row.residualCount,
    runtimeNodeId: row.runtimeNodeId,
    subjectId: row.subjectId,
    workspaceId: row.workspaceId,
  })
}

export type RetentionGateInput = Readonly<{
  /** The owning domain's retention anchor for this subject, as an ISO timestamp. */
  anchorAt: string
  category: RetentionCategory
  periods?: RetentionPeriods
  /** Supplied by the owning domain. An unknown or open reconciliation is `true`. */
  reconciliationOpen: boolean
  subjectId: string
  workspaceId: string
}>

export type RetentionGateContext = Readonly<{ now: string }>

/**
 * Decide one subject's deletion under locks and run `callback` with that
 * decision while the locks are still held. The callback is where a caller
 * would dispatch cleanup, so the dispatch can never act on a stale decision.
 * This slice does not dispatch anything. Errors thrown by the callback roll the
 * transaction back.
 */
export async function withRetentionDeletionGate<T>(
  database: AgentHqDatabase,
  input: RetentionGateInput,
  callback: (decision: RetentionDecision, context: RetentionGateContext) => Promise<T>
): Promise<T> {
  validateScope(input.workspaceId, input.category, input.subjectId)
  if (typeof input.reconciliationOpen !== 'boolean') reject('invalid_input')
  timestampMs(input.anchorAt)
  return database.transaction(async (transaction) => {
    if (input.category === 'artifacts')
      await lockArtifactRow(transaction, input.workspaceId, input.subjectId)
    await lockSubject(transaction, input.workspaceId, input.category, input.subjectId)

    // Every awaited read happens under the lock, before the decision instant is sampled.
    const authority = await liveAuthorization(
      transaction,
      input.workspaceId,
      input.category,
      input.subjectId
    )
    const holdRows = await transaction
      .select()
      .from(retentionHolds)
      .where(
        and(
          eq(retentionHolds.workspaceId, input.workspaceId),
          eq(retentionHolds.category, input.category),
          eq(retentionHolds.subjectId, input.subjectId)
        )
      )
    // Only evidence recorded under the live request generation can count. Earlier
    // generations and other categories never reach the pure gate.
    const receiptRows = authority
      ? await transaction
          .select()
          .from(retentionCleanupReceipts)
          .where(
            and(
              eq(retentionCleanupReceipts.workspaceId, input.workspaceId),
              eq(retentionCleanupReceipts.category, input.category),
              eq(retentionCleanupReceipts.subjectId, input.subjectId),
              eq(retentionCleanupReceipts.authorizationId, authority.id)
            )
          )
      : []
    const referenceRows = await activeArtifactReferenceRows(
      transaction,
      input.workspaceId,
      input.category,
      input.subjectId
    )
    const receipts: CleanupReceipt[] = receiptRows.map((row) => ({
      category: row.category,
      coverage: row.coverage,
      executorId: row.runtimeNodeId,
      observedAt: row.observedAt.toISOString(),
      operation: row.operation,
      outcome: row.outcome,
      requestId: row.authorizationId,
      residualCount: row.residualCount,
      subjectId: row.subjectId,
    }))
    const trustedExecutors = await trustedExecutorsFor(
      transaction,
      input.workspaceId,
      receipts.map((receipt) => receipt.executorId)
    )

    // The final decision instant: sampled after the last awaited read. Expiry of the
    // authority, of each reference, and of each receipt window is judged here.
    const nowMs = await databaseNowMs(transaction)
    const now = iso(nowMs)
    const epoch = iso(0)
    // A missing grant is refused through the same current-authority rule: an
    // epoch-bounded record is never current, and every earlier refusal still
    // takes precedence.
    const authorization: RetentionAuthorization = authority
      ? {
          expiresAt: authority.expiresAt.toISOString(),
          grantedAt: authority.grantedAt.toISOString(),
          id: authority.id,
          revokedAt: null,
        }
      : { expiresAt: epoch, grantedAt: epoch, id: NO_AUTHORITY, revokedAt: epoch }
    const holds: RetentionHold[] = holdRows.map((row) => ({
      id: row.id,
      releasedAt: row.releasedAt?.toISOString() ?? null,
    }))

    let decision: RetentionDecision
    try {
      decision = evaluateRetentionDeletion({
        candidate: {
          activeReferenceCount: liveReferenceCount(referenceRows, nowMs),
          anchorAt: input.anchorAt,
          authorization,
          category: input.category,
          holds,
          reconciliationOpen: input.reconciliationOpen,
          subjectId: input.subjectId,
        },
        now,
        periods: input.periods ?? UNSET_RETENTION_PERIODS,
        receipts,
        trustedExecutors,
      })
    } catch (error) {
      if (error instanceof RetentionPolicyError) reject('invalid_input')
      throw error
    }
    return callback(decision, { now })
  })
}

/** The gate's decision alone, for callers that do not dispatch under the lock. */
export async function evaluateStoredRetentionDeletion(
  database: AgentHqDatabase,
  input: RetentionGateInput
): Promise<RetentionDecision> {
  return withRetentionDeletionGate(database, input, async (decision) => decision)
}

/** The current authority row for one subject, if any (read-only). */
export async function readLiveRetentionDeletionAuthorization(
  database: AgentHqDatabase,
  workspaceId: string,
  category: RetentionCategory,
  subjectId: string
): Promise<RetentionAuthorizationRecord | null> {
  validateScope(workspaceId, category, subjectId)
  const row = await liveAuthorization(database, workspaceId, category, subjectId)
  return row ? authorizationRecord(row) : null
}

export type RetentionStatusView = Readonly<{
  authorization: RetentionAuthorizationRecord | null
  category: RetentionCategory
  decision:
    | Readonly<{ outcome: 'refused'; reason: 'policy_unset' }>
    | Readonly<{ outcome: 'undetermined'; reason: 'anchor_required' }>
  evidence: Readonly<{ coverage: Readonly<Record<string, number>>; receipts: number }>
  holds: ReadonlyArray<Readonly<{ id: string; releasedAt: string | null }>>
  periodConfigured: boolean
  subjectId: string
  workspaceId: string
}>

/**
 * Read-only retention status for one subject (#1221). It writes nothing, takes
 * no lock, and dispatches nothing. Evidence counts come only from the live
 * generation. The period decision stays fail-closed: while a category's period is
 * unset the answer is `policy_unset`. A configured period cannot be judged here,
 * because the owning domain's anchor is not part of this read.
 */
export async function readRetentionStatus(
  database: AgentHqDatabase,
  input: Readonly<{
    category: RetentionCategory
    periods?: RetentionPeriods
    subjectId: string
    workspaceId: string
  }>
): Promise<RetentionStatusView> {
  validateScope(input.workspaceId, input.category, input.subjectId)
  const periods = input.periods ?? UNSET_RETENTION_PERIODS
  const periodConfigured = periods[input.category] !== null
  const authority = await liveAuthorization(
    database,
    input.workspaceId,
    input.category,
    input.subjectId
  )
  const holds = await database
    .select({ id: retentionHolds.id, releasedAt: retentionHolds.releasedAt })
    .from(retentionHolds)
    .where(
      and(
        eq(retentionHolds.workspaceId, input.workspaceId),
        eq(retentionHolds.category, input.category),
        eq(retentionHolds.subjectId, input.subjectId)
      )
    )
  const receipts = authority
    ? await database
        .select({ coverage: retentionCleanupReceipts.coverage })
        .from(retentionCleanupReceipts)
        .where(
          and(
            eq(retentionCleanupReceipts.workspaceId, input.workspaceId),
            eq(retentionCleanupReceipts.category, input.category),
            eq(retentionCleanupReceipts.subjectId, input.subjectId),
            eq(retentionCleanupReceipts.authorizationId, authority.id)
          )
        )
    : []
  const coverage: Record<string, number> = {}
  for (const row of receipts) coverage[row.coverage] = (coverage[row.coverage] ?? 0) + 1
  return Object.freeze({
    authorization: authority ? authorizationRecord(authority) : null,
    category: input.category,
    decision: periodConfigured
      ? ({ outcome: 'undetermined', reason: 'anchor_required' } as const)
      : ({ outcome: 'refused', reason: 'policy_unset' } as const),
    evidence: Object.freeze({ coverage: Object.freeze(coverage), receipts: receipts.length }),
    holds: Object.freeze(
      holds.map((row) =>
        Object.freeze({ id: row.id, releasedAt: row.releasedAt?.toISOString() ?? null })
      )
    ),
    periodConfigured,
    subjectId: input.subjectId,
    workspaceId: input.workspaceId,
  })
}
