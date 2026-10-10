import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { fingerprintOf } from '../../src/runtime-nodes'
import {
  evaluateStoredRetentionDeletion,
  grantRetentionDeletionAuthorization,
  recordRetentionCleanupReceipt,
  RetentionCleanupError,
  revokeRetentionDeletionAuthorization,
  type RetentionGateInput,
  type StoredCleanupReceiptInput,
} from '../../src/retention-cleanup'
import {
  parseRetentionPeriods,
  RETENTION_COVERAGE_RULES,
  UNSET_RETENTION_PERIODS,
  type CleanupCoverageKind,
  type RetentionCategory,
  type RetentionDecision,
} from '../../src/retention-policy'
import {
  retentionCleanupReceipts,
  retentionDeletionAuthorizations,
  runtimeNodeKeys,
  runtimeNodes,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import type { UserPrincipalRef } from '@adea-ai/types'

/**
 * Receipt-generation isolation through PostgreSQL (#1243). Each case shows one
 * way stored evidence could answer the wrong question. The clock is the
 * database clock, and every observation is anchored to a generation's own
 * `granted_at`. This keeps the cases independent of host and container clock
 * skew, which here is tens of milliseconds.
 */

const connectionUrl = process.env.DATABASE_URL
const DAY_PERIODS = parseRetentionPeriods(
  Object.fromEntries(Object.keys(UNSET_RETENTION_PERIODS).map((category) => [category, 1]))
)
const EXPIRED_ANCHOR = new Date(Date.now() - 3 * 86_400_000).toISOString()
const CHECKS = RETENTION_COVERAGE_RULES.messages.requiredCoverage

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type Observation = Readonly<{
  coverage: CleanupCoverageKind
  observedAt: string
  operation: 'delete' | 'read_check'
  outcome: 'completed' | 'failed' | 'in_progress' | 'unreachable'
  residualCount: number
  subjectId: string
}>

function observed(
  subjectId: string,
  coverage: CleanupCoverageKind,
  operation: 'delete' | 'read_check',
  observedAt: string,
  overrides: Partial<Observation> = {}
): Observation {
  return {
    coverage,
    observedAt,
    operation,
    outcome: 'completed',
    residualCount: 0,
    subjectId,
    ...overrides,
  }
}

/** The result of one call: `recorded`, `replayed`, or the typed refusal code. */
async function attempt(call: () => Promise<{ outcome: string }>): Promise<string> {
  try {
    return (await call()).outcome
  } catch (error) {
    if (error instanceof RetentionCleanupError) return error.code
    throw error
  }
}

function blockerFor(decision: RetentionDecision, coverage: CleanupCoverageKind) {
  if (decision.outcome !== 'pending') return undefined
  const found = decision.blockers.find(
    (blocker) => blocker.kind === 'coverage' && blocker.coverage === coverage
  )
  return found && found.kind === 'coverage' ? found.reason : undefined
}

function recordInput(
  workspaceId: string,
  executor: { kind: 'runtime_node'; runtimeNodeId: string },
  key: string,
  receipt: object,
  category: RetentionCategory = 'messages'
): StoredCleanupReceiptInput {
  return { category, executor, idempotencyKey: key, receipt, workspaceId }
}

function gateInput(
  workspaceId: string,
  subjectId: string,
  category: RetentionCategory = 'messages'
): RetentionGateInput {
  return {
    anchorAt: EXPIRED_ANCHOR,
    category,
    periods: DAY_PERIODS,
    reconciliationOpen: false,
    subjectId,
    workspaceId,
  }
}

describe.skipIf(!connectionUrl)('Receipt-generation isolation (stored)', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    for (const workspaceId of workspaceIds) {
      await connection.db
        .delete(retentionCleanupReceipts)
        .where(eq(retentionCleanupReceipts.workspaceId, workspaceId))
      await connection.db
        .delete(retentionDeletionAuthorizations)
        .where(eq(retentionDeletionAuthorizations.workspaceId, workspaceId))
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    }
    await connection.close()
  })

  async function owner(name: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `isolation-${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
    return session.principal
  }

  /** A live workspace, one signing-key executor, and the owner who grants authority. */
  async function fixture(name: string) {
    const principal = await owner(name)
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `isolation-${name}-${crypto.randomUUID()}`,
      name: `isolation ${name}`,
      owner: principal,
    })
    workspaceIds.push(workspace.id)
    const [node] = await connection.db
      .insert(runtimeNodes)
      .values({
        displayName: `${name} executor`,
        kind: 'local_device',
        ownerUserId: principal.userId,
        platform: 'darwin',
        softwareVersion: '1.0.0',
        workspaceId: workspace.id,
      })
      .returning()
    const publicKey = `isolation-signing-${crypto.randomUUID()}`
    await connection.db.insert(runtimeNodeKeys).values({
      algorithm: 'ed25519',
      fingerprint: fingerprintOf(publicKey),
      keyVersion: 1,
      publicKey,
      role: 'signing',
      runtimeNodeId: node!.id,
      verifiedAt: new Date(),
    })
    return {
      executor: { kind: 'runtime_node' as const, runtimeNodeId: node!.id },
      owner: principal,
      workspaceId: workspace.id,
    }
  }

  /** Grants authority and lets the database clock move past the grant before any observation. */
  async function grant(
    actor: UserPrincipalRef,
    workspaceId: string,
    subjectId: string,
    category: RetentionCategory = 'messages'
  ) {
    const record = await grantRetentionDeletionAuthorization(connection.db, {
      actor,
      category,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      subjectId,
      workspaceId,
    })
    await sleep(20)
    return record
  }

  async function storedCount(workspaceId: string): Promise<number> {
    return (
      await connection.db
        .select({ id: retentionCleanupReceipts.id })
        .from(retentionCleanupReceipts)
        .where(eq(retentionCleanupReceipts.workspaceId, workspaceId))
    ).length
  }

  test('a future observation is refused and stores nothing', async () => {
    const { executor, owner: actor, workspaceId } = await fixture('future')
    const subject = crypto.randomUUID()
    await grant(actor, workspaceId, subject)
    const future = new Date(Date.now() + 60_000).toISOString()
    const result = await attempt(() =>
      recordRetentionCleanupReceipt(
        connection.db,
        recordInput(
          workspaceId,
          executor,
          'future-1',
          observed(subject, 'primary', 'delete', future)
        )
      )
    )
    expect(result).toBe('receipt_outside_window')
    expect(await storedCount(workspaceId)).toBe(0)
  })

  test('a stale observation from before the generation is refused; the grant instant itself is inside', async () => {
    const { executor, owner: actor, workspaceId } = await fixture('stale')
    const subject = crypto.randomUUID()
    const generation = await grant(actor, workspaceId, subject)
    const grantedMs = Date.parse(generation.grantedAt)
    const stale = await attempt(() =>
      recordRetentionCleanupReceipt(
        connection.db,
        recordInput(
          workspaceId,
          executor,
          'stale-1',
          observed(subject, 'primary', 'delete', new Date(grantedMs - 1).toISOString())
        )
      )
    )
    expect(stale).toBe('receipt_outside_window')
    const atGrant = await attempt(() =>
      recordRetentionCleanupReceipt(
        connection.db,
        recordInput(
          workspaceId,
          executor,
          'stale-2',
          observed(subject, 'primary', 'delete', new Date(grantedMs).toISOString())
        )
      )
    )
    expect(atGrant).toBe('recorded')
  })

  test('equal-time conflicting deletes are ambiguous in either insertion order', async () => {
    const { executor, owner: actor, workspaceId } = await fixture('equal-deletes')
    const orders = [
      ['completed', 'failed'],
      ['failed', 'completed'],
    ] as const
    const decisions: RetentionDecision[] = []
    for (const [index, order] of orders.entries()) {
      const subject = crypto.randomUUID()
      const generation = await grant(actor, workspaceId, subject)
      const at = new Date(Date.parse(generation.grantedAt) + 5).toISOString()
      for (const [position, outcome] of order.entries()) {
        await recordRetentionCleanupReceipt(
          connection.db,
          recordInput(
            workspaceId,
            executor,
            `equal-delete-${index}-${position}`,
            observed(subject, 'primary', 'delete', at, {
              outcome,
              ...(outcome === 'failed' ? { residualCount: 0 } : {}),
            })
          )
        )
      }
      decisions.push(
        await evaluateStoredRetentionDeletion(connection.db, gateInput(workspaceId, subject))
      )
    }
    for (const decision of decisions) {
      expect(blockerFor(decision, 'primary')).toBe('ambiguous_order')
    }
  })

  test('equal-time conflicting reads are ambiguous in either insertion order', async () => {
    const { executor, owner: actor, workspaceId } = await fixture('equal-reads')
    const decisions: RetentionDecision[] = []
    for (const [index, clean] of [true, false].entries()) {
      const subject = crypto.randomUUID()
      const generation = await grant(actor, workspaceId, subject)
      const deleteAt = new Date(Date.parse(generation.grantedAt) + 5).toISOString()
      const readAt = new Date(Date.parse(generation.grantedAt) + 6).toISOString()
      await recordRetentionCleanupReceipt(
        connection.db,
        recordInput(
          workspaceId,
          executor,
          `equal-read-${index}-delete`,
          observed(subject, 'primary', 'delete', deleteAt)
        )
      )
      const cleanRead = observed(subject, 'primary', 'read_check', readAt)
      const residualRead = observed(subject, 'primary', 'read_check', readAt, { residualCount: 3 })
      const order = clean ? [cleanRead, residualRead] : [residualRead, cleanRead]
      for (const [position, receipt] of order.entries()) {
        await recordRetentionCleanupReceipt(
          connection.db,
          recordInput(workspaceId, executor, `equal-read-${index}-${position}`, receipt)
        )
      }
      decisions.push(
        await evaluateStoredRetentionDeletion(connection.db, gateInput(workspaceId, subject))
      )
    }
    for (const decision of decisions) {
      expect(blockerFor(decision, 'primary')).toBe('ambiguous_order')
    }
  })

  test('a read at or before the delete never verifies; one millisecond later verifies every kind', async () => {
    const { executor, owner: actor, workspaceId } = await fixture('ordering')
    for (const [label, offsetMs] of [
      ['before', 4],
      ['equal', 5],
    ] as const) {
      const subject = crypto.randomUUID()
      const generation = await grant(actor, workspaceId, subject)
      const base = Date.parse(generation.grantedAt)
      for (const kind of CHECKS) {
        await recordRetentionCleanupReceipt(
          connection.db,
          recordInput(
            workspaceId,
            executor,
            `ordering-${label}-${kind}-delete`,
            observed(subject, kind, 'delete', new Date(base + 5).toISOString())
          )
        )
        await recordRetentionCleanupReceipt(
          connection.db,
          recordInput(
            workspaceId,
            executor,
            `ordering-${label}-${kind}-read`,
            observed(subject, kind, 'read_check', new Date(base + offsetMs).toISOString())
          )
        )
      }
      const decision = await evaluateStoredRetentionDeletion(
        connection.db,
        gateInput(workspaceId, subject)
      )
      expect(blockerFor(decision, 'primary')).toBe('coverage_incomplete')
    }

    const subject = crypto.randomUUID()
    const generation = await grant(actor, workspaceId, subject)
    const base = Date.parse(generation.grantedAt)
    for (const kind of CHECKS) {
      await recordRetentionCleanupReceipt(
        connection.db,
        recordInput(
          workspaceId,
          executor,
          `ordering-after-${kind}-delete`,
          observed(subject, kind, 'delete', new Date(base + 5).toISOString())
        )
      )
      await recordRetentionCleanupReceipt(
        connection.db,
        recordInput(
          workspaceId,
          executor,
          `ordering-after-${kind}-read`,
          observed(subject, kind, 'read_check', new Date(base + 6).toISOString())
        )
      )
    }
    expect(
      await evaluateStoredRetentionDeletion(connection.db, gateInput(workspaceId, subject))
    ).toEqual({
      coverage: CHECKS,
      outcome: 'verified_complete',
    })
  })

  test('a receipt for another subject never answers this subject, and a subject without authority cannot be recorded', async () => {
    const { executor, owner: actor, workspaceId } = await fixture('subject')
    const authorized = crypto.randomUUID()
    const other = crypto.randomUUID()
    const generation = await grant(actor, workspaceId, authorized)
    const at = new Date(Date.parse(generation.grantedAt) + 5).toISOString()
    expect(
      await attempt(() =>
        recordRetentionCleanupReceipt(
          connection.db,
          recordInput(
            workspaceId,
            executor,
            'subject-other',
            observed(other, 'primary', 'delete', at)
          )
        )
      )
    ).toBe('authorization_not_current')
    expect(
      await evaluateStoredRetentionDeletion(connection.db, gateInput(workspaceId, other))
    ).toEqual({
      outcome: 'refused',
      reason: 'authorization_not_current',
    })
  })

  test('a payload naming another request generation or category is refused, and the live generation is accepted', async () => {
    const { executor, owner: actor, workspaceId } = await fixture('request')
    const subject = crypto.randomUUID()
    const first = await grant(actor, workspaceId, subject)
    await revokeRetentionDeletionAuthorization(connection.db, {
      actor,
      authorizationId: first.id,
      workspaceId,
    })
    const second = await grant(actor, workspaceId, subject)
    const at = new Date(Date.parse(second.grantedAt) + 5).toISOString()
    const body = observed(subject, 'primary', 'delete', at)

    expect(
      await attempt(() =>
        recordRetentionCleanupReceipt(
          connection.db,
          recordInput(workspaceId, executor, 'request-old', { ...body, requestId: first.id })
        )
      )
    ).toBe('receipt_request_mismatch')
    expect(
      await attempt(() =>
        recordRetentionCleanupReceipt(
          connection.db,
          recordInput(workspaceId, executor, 'request-category', { ...body, category: 'logs' })
        )
      )
    ).toBe('receipt_request_mismatch')
    expect(
      await attempt(() =>
        recordRetentionCleanupReceipt(
          connection.db,
          recordInput(workspaceId, executor, 'request-live', { ...body, requestId: second.id })
        )
      )
    ).toBe('recorded')
  })

  test('a replayed key from an earlier generation never returns as a replay under the new one', async () => {
    const { executor, owner: actor, workspaceId } = await fixture('replay')
    const subject = crypto.randomUUID()
    const first = await grant(actor, workspaceId, subject)
    const firstAt = new Date(Date.parse(first.grantedAt) + 5).toISOString()
    const original = observed(subject, 'primary', 'delete', firstAt)
    expect(
      await attempt(() =>
        recordRetentionCleanupReceipt(
          connection.db,
          recordInput(workspaceId, executor, 'replay-key', original)
        )
      )
    ).toBe('recorded')
    await revokeRetentionDeletionAuthorization(connection.db, {
      actor,
      authorizationId: first.id,
      workspaceId,
    })
    const second = await grant(actor, workspaceId, subject)
    expect(
      await attempt(() =>
        recordRetentionCleanupReceipt(
          connection.db,
          recordInput(workspaceId, executor, 'replay-key', original)
        )
      )
    ).toBe('receipt_outside_window')
    const laterAt = new Date(Date.parse(second.grantedAt) + 5).toISOString()
    expect(
      await attempt(() =>
        recordRetentionCleanupReceipt(
          connection.db,
          recordInput(
            workspaceId,
            executor,
            'replay-key',
            observed(subject, 'primary', 'delete', laterAt)
          )
        )
      )
    ).toBe('receipt_conflict')
  })

  test('a receipt recorded for one category cannot satisfy another category gate', async () => {
    const { executor, owner: actor, workspaceId } = await fixture('category')
    const subject = crypto.randomUUID()
    const generation = await grant(actor, workspaceId, subject, 'messages')
    const at = new Date(Date.parse(generation.grantedAt) + 5).toISOString()
    for (const kind of CHECKS) {
      await recordRetentionCleanupReceipt(
        connection.db,
        recordInput(
          workspaceId,
          executor,
          `category-${kind}`,
          observed(subject, kind, 'delete', at),
          'messages'
        )
      )
    }
    expect(
      await evaluateStoredRetentionDeletion(connection.db, gateInput(workspaceId, subject, 'logs'))
    ).toEqual({ outcome: 'refused', reason: 'authorization_not_current' })
  })
})
