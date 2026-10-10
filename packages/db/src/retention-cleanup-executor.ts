import { sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { withRetentionDeletionGate } from './retention-cleanup'
import {
  RETENTION_COVERAGE_RULES,
  type CleanupCoverageKind,
  type CleanupReceiptOperation,
  type CleanupReceiptOutcome,
  type RetentionCategory,
  type RetentionDecision,
  type RetentionPeriods,
} from './retention-policy'

/**
 * Source-level cleanup executor composition (#1221). It runs only inside the
 * retention gate: the gate decides under the subject lock, and only a decision of
 * `cleanup_ready` with a live generation reaches a store. Deletion and read-back
 * happen in the gate's transaction, so holds, revocations, reference
 * registrations, and reconciliation changes for the subject wait for the commit.
 * Receipts are submitted after the commit, through the caller's signed submission
 * port, and only once the database clock has passed each observation.
 *
 * Nothing here schedules work or chooses a period. A caller passes periods
 * explicitly, and an unset period refuses before any store is touched.
 */

export type RetentionCleanupSubject = Readonly<{
  category: RetentionCategory
  subjectId: string
  workspaceId: string
}>

export type RetentionCleanupStoreOutcome = 'completed' | 'failed' | 'unreachable'

/**
 * One store for one coverage kind. Both methods run inside the gate transaction,
 * with the subject lock held. An implementation must act only on the given
 * subject, and must not report completion it did not perform. The executor checks
 * the generation before each call and before each completion claim. A call already
 * in flight when expiry passes still finishes; its result is recorded as it is, and
 * nothing after it is claimed or called.
 */
export type RetentionCleanupStorePort = Readonly<{
  coverage: CleanupCoverageKind
  deleteSubject(
    transaction: AgentHqTransaction,
    subject: RetentionCleanupSubject
  ): Promise<RetentionCleanupStoreOutcome>
  residualCount(transaction: AgentHqTransaction, subject: RetentionCleanupSubject): Promise<number>
}>

/** A receipt payload the node signs and submits. Identity is explicit. */
export type RetentionReceiptDraft = Readonly<{
  category: RetentionCategory
  coverage: CleanupCoverageKind
  observedAt: string
  operation: CleanupReceiptOperation
  outcome: CleanupReceiptOutcome
  requestId: string
  residualCount: number
  subjectId: string
}>

export type RetentionCleanupHaltReason =
  | 'authorization_not_current'
  | 'store_not_completed'
  | 'store_result_invalid'
  | 'residual_invalid'
  | 'residual_remaining'

/**
 * Why the executor stopped before every store was verified. Stores after `coverage`
 * were not called. Nothing is claimed for `coverage` beyond the drafts already made.
 */
export type RetentionCleanupHalt = Readonly<{
  coverage: CleanupCoverageKind
  reason: RetentionCleanupHaltReason
}>

export type RetentionCleanupExecution = Readonly<{
  decision: RetentionDecision
  drafts: readonly RetentionReceiptDraft[]
  halt: RetentionCleanupHalt | null
  status: 'executed' | 'skipped'
}>

/** A store result outside the declared outcomes is not a completion and is not a receipt. */
function isStoreOutcome(value: unknown): value is RetentionCleanupStoreOutcome {
  return value === 'completed' || value === 'failed' || value === 'unreachable'
}

/** A residual count is a safe, non-negative integer. Anything else proves nothing. */
function isResidualCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

async function databaseClockMs(transaction: AgentHqTransaction | AgentHqDatabase): Promise<number> {
  const rows = await transaction.execute(
    sql`select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms`
  )
  return Number((rows[0] as { ms?: unknown } | undefined)?.ms)
}

/** Waits until the database clock has passed `targetMs`, so a receipt is never ahead of it. */
async function awaitDatabaseClock(database: AgentHqDatabase, targetMs: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while ((await databaseClockMs(database)) < targetMs) {
    if (Date.now() > deadline) throw new Error('database clock did not reach the observation')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function draft(
  input: RetentionCleanupSubject,
  requestId: string,
  coverage: CleanupCoverageKind,
  operation: CleanupReceiptOperation,
  outcome: CleanupReceiptOutcome,
  observedMs: number,
  residualCount: number
): RetentionReceiptDraft {
  return Object.freeze({
    category: input.category,
    coverage,
    observedAt: new Date(observedMs).toISOString(),
    operation,
    outcome,
    requestId,
    residualCount,
    subjectId: input.subjectId,
  })
}

export async function runRetentionCleanupExecutor(
  database: AgentHqDatabase,
  input: RetentionCleanupSubject &
    Readonly<{
      anchorAt: string
      periods?: RetentionPeriods
      reconciliationOpen: boolean
      stores: readonly RetentionCleanupStorePort[]
      submit(receipt: RetentionReceiptDraft): Promise<void>
    }>
): Promise<RetentionCleanupExecution> {
  const rule = RETENTION_COVERAGE_RULES[input.category]
  const storeFor = new Map(input.stores.map((store) => [store.coverage, store]))
  for (const coverage of rule.requiredCoverage) {
    // Fail closed before the gate: a missing port means no deletion can be claimed.
    if (!storeFor.has(coverage)) throw new Error('retention cleanup store port missing')
  }
  const subject: RetentionCleanupSubject = {
    category: input.category,
    subjectId: input.subjectId,
    workspaceId: input.workspaceId,
  }

  const execution = await withRetentionDeletionGate(
    database,
    {
      anchorAt: input.anchorAt,
      category: input.category,
      periods: input.periods,
      reconciliationOpen: input.reconciliationOpen,
      subjectId: input.subjectId,
      workspaceId: input.workspaceId,
    },
    async (decision, context): Promise<RetentionCleanupExecution> => {
      if (decision.outcome !== 'cleanup_ready' || !context.authorization)
        return { decision, drafts: [], halt: null, status: 'skipped' }
      const requestId = context.authorization.id
      const drafts: RetentionReceiptDraft[] = []
      let halt: RetentionCleanupHalt | null = null
      for (const coverage of rule.requiredCoverage) {
        const store = storeFor.get(coverage)!
        // Fail closed: a store is called only while this generation is current on the
        // database clock. Earlier stores may have run long enough for expiry to pass.
        if (!(await context.isAuthorizationCurrent())) {
          halt = { coverage, reason: 'authorization_not_current' }
          break
        }
        const deletedMs = await databaseClockMs(context.transaction)
        const outcome: unknown = await store.deleteSubject(context.transaction, subject)
        // An unrecognised result is unknown, not a failure report. It gets no receipt.
        if (!isStoreOutcome(outcome)) {
          halt = { coverage, reason: 'store_result_invalid' }
          break
        }
        drafts.push(draft(subject, requestId, coverage, 'delete', outcome, deletedMs, 0))
        // Fail closed: stop at the first store that did not complete, so later stores keep their data.
        if (outcome !== 'completed') {
          halt = { coverage, reason: 'store_not_completed' }
          break
        }
        // Read-back runs after the delete, strictly later in the receipt timeline.
        const readMs = Math.max(await databaseClockMs(context.transaction), deletedMs + 1)
        const residual: unknown = await store.residualCount(context.transaction, subject)
        // Invalid counts are not zero. Stop before any later store, and claim no absence for this one.
        if (!isResidualCount(residual)) {
          halt = { coverage, reason: 'residual_invalid' }
          break
        }
        // Completion is claimed only if the generation is still current after the read-back.
        if (!(await context.isAuthorizationCurrent())) {
          halt = { coverage, reason: 'authorization_not_current' }
          break
        }
        drafts.push(
          draft(subject, requestId, coverage, 'read_check', 'completed', readMs, residual)
        )
        if (residual > 0) {
          halt = { coverage, reason: 'residual_remaining' }
          break
        }
      }
      return { decision, drafts, halt, status: 'executed' }
    }
  )

  // Submission happens after commit, and each receipt waits until the database clock has passed it.
  for (const receipt of execution.drafts) {
    await awaitDatabaseClock(database, Date.parse(receipt.observedAt))
    await input.submit(receipt)
  }
  return execution
}
