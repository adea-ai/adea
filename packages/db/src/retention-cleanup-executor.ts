import { sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { withRetentionDeletionGate } from './retention-cleanup'
import {
  type CleanupCoverageKind,
  type CleanupReceiptOperation,
  type CleanupReceiptOutcome,
  type RetentionCategory,
  type RetentionCoverageInventory,
  type RetentionDecision,
  type RetentionPeriods,
  parseRetentionCoverageInventory,
  retentionCategoryRule,
} from './retention-policy'

/**
 * Source-level cleanup executor composition (#1221). It runs only inside the
 * retention gate: the gate decides under the subject lock, and only a decision of
 * an initial `cleanup_ready` decision or a retryable coverage-pending decision
 * with a live generation reaches its assigned stores. The explicit coverage
 * inventory names every executor whose evidence is required; a missing member
 * fails closed. Deletion and read-back happen in the gate's transaction, so holds, revocations, reference
 * registrations, and reconciliation changes for the subject wait for the commit.
 * Before each store is called, the same transaction records a durable deletion
 * dispatch mark (`retention_deletion_dispatches`), which commits or rolls back with the
 * deletion. Receipts are submitted after the commit, through the caller's signed
 * submission port, and only once the database clock has passed each observation, but
 * the mark does not depend on them: it is the evidence the artifact registration fence
 * relies on when a generation is revoked before any receipt is accepted.
 * An ordinary exception from a store port is caught inside the gate and halts with
 * `store_error`, allowing the mark to commit without a completion receipt for that
 * coverage. This requires the database transaction to remain usable. A PostgreSQL
 * transaction abort, connection loss, or process failure can still roll the mark back
 * while an out-of-transaction effect (an object store or external index) survives; such
 * stores need their own durable dispatch intent and reconciliation before production use.
 *
 * A pending generation can be retried after an unreachable or failed store, or
 * after receipt submission was interrupted. No receipt from a retry replaces
 * another executor's required evidence. Nothing here schedules work or chooses
 * a period; an unset period refuses before any store is touched.
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
  | 'store_error'
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
      /** The authenticated executor identity for this invocation. */
      executorId: string
      /** Every node that must report for each required coverage. */
      coverageInventory: RetentionCoverageInventory
      periods?: RetentionPeriods
      reconciliationOpen: boolean
      stores: readonly RetentionCleanupStorePort[]
      submit(receipt: RetentionReceiptDraft): Promise<void>
    }>
): Promise<RetentionCleanupExecution> {
  const rule = retentionCategoryRule(input.category)
  const inventory = parseRetentionCoverageInventory(input.coverageInventory, input.category)
  if (!inventory.complete) throw new Error('retention cleanup coverage inventory incomplete')
  const storeFor = new Map<CleanupCoverageKind, RetentionCleanupStorePort>()
  for (const store of input.stores) {
    if (!rule.requiredCoverage.includes(store.coverage))
      throw new Error('retention cleanup store port not required')
    if (storeFor.has(store.coverage)) throw new Error('retention cleanup store port duplicated')
    if (!inventory.executorsByCoverage.get(store.coverage)?.includes(input.executorId))
      throw new Error('retention cleanup executor not assigned to store')
    storeFor.set(store.coverage, store)
  }
  let assignedCoverageCount = 0
  for (const coverage of rule.requiredCoverage) {
    if (inventory.executorsByCoverage.get(coverage)?.includes(input.executorId)) {
      assignedCoverageCount++
      if (!storeFor.has(coverage)) throw new Error('retention cleanup store port missing')
    }
  }
  if (assignedCoverageCount === 0)
    throw new Error('retention cleanup executor has no assigned stores')
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
      coverageInventory: input.coverageInventory,
    },
    async (decision, context): Promise<RetentionCleanupExecution> => {
      const retryablePending =
        decision.outcome === 'pending' &&
        decision.blockers.length > 0 &&
        decision.blockers.every((blocker) => blocker.kind === 'coverage')
      if ((decision.outcome !== 'cleanup_ready' && !retryablePending) || !context.authorization)
        return { decision, drafts: [], halt: null, status: 'skipped' }
      const requestId = context.authorization.id
      const drafts: RetentionReceiptDraft[] = []
      let halt: RetentionCleanupHalt | null = null
      for (const coverage of rule.requiredCoverage) {
        const store = storeFor.get(coverage)
        if (!store) continue
        // Fail closed: a store is called only while this generation is current on the
        // database clock. Earlier stores may have run long enough for expiry to pass.
        if (!(await context.isAuthorizationCurrent())) {
          halt = { coverage, reason: 'authorization_not_current' }
          break
        }
        // Durable evidence first, in this transaction. Database deletes share its commit;
        // external effects need separate reconciliation if this transaction aborts.
        await context.markDeletionDispatched(coverage)
        const deletedMs = await databaseClockMs(context.transaction)
        let outcome: unknown
        try {
          outcome = await store.deleteSubject(context.transaction, subject)
        } catch {
          // Preserve the dispatch mark when an adapter throws without aborting the database
          // transaction. The unknown delete outcome gets no receipt.
          halt = { coverage, reason: 'store_error' }
          break
        }
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
        let residual: unknown
        try {
          residual = await store.residualCount(context.transaction, subject)
        } catch {
          // The delete result may be recorded, but no read-check can claim absence.
          halt = { coverage, reason: 'store_error' }
          break
        }
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
