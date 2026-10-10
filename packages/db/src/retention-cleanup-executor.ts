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
 * subject, and must not report completion it did not perform.
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

export type RetentionCleanupExecution = Readonly<{
  decision: RetentionDecision
  drafts: readonly RetentionReceiptDraft[]
  status: 'executed' | 'skipped'
}>

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
        return { decision, drafts: [], status: 'skipped' }
      const requestId = context.authorization.id
      const drafts: RetentionReceiptDraft[] = []
      for (const coverage of rule.requiredCoverage) {
        const store = storeFor.get(coverage)!
        const deletedMs = await databaseClockMs(context.transaction)
        const outcome = await store.deleteSubject(context.transaction, subject)
        drafts.push(draft(subject, requestId, coverage, 'delete', outcome, deletedMs, 0))
        // Fail closed: stop at the first store that did not complete, so later stores keep their data.
        if (outcome !== 'completed') break
        // Read-back runs after the delete, strictly later in the receipt timeline.
        const readMs = Math.max(await databaseClockMs(context.transaction), deletedMs + 1)
        const residual = await store.residualCount(context.transaction, subject)
        drafts.push(
          draft(subject, requestId, coverage, 'read_check', 'completed', readMs, residual)
        )
        if (residual > 0) break
      }
      return { decision, drafts, status: 'executed' }
    }
  )

  // Submission happens after commit, and each receipt waits until the database clock has passed it.
  for (const receipt of execution.drafts) {
    await awaitDatabaseClock(database, Date.parse(receipt.observedAt))
    await input.submit(receipt)
  }
  return execution
}
