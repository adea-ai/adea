import { describe, expect, test } from 'bun:test'

import {
  CLEANUP_COVERAGE_KINDS,
  evaluateRetentionDeletion,
  parseRetentionPeriods,
  retentionCategoryRule,
  RETENTION_CATEGORIES,
  RETENTION_COVERAGE_RULES,
  RetentionPolicyError,
  UNSET_RETENTION_PERIODS,
  type CleanupCoverageKind,
  type CleanupReceipt,
  type CleanupReceiptOperation,
  type CleanupReceiptOutcome,
  type RetentionCandidate,
  type RetentionCategory,
  type RetentionCoverageInventory,
  type RetentionEvaluationInput,
  type TrustedCleanupExecutor,
} from '../../src/retention-policy'

/**
 * The per-category policy contract of M18.02 (#1221).
 *
 * The eight categories are separate policies, not one policy with eight labels:
 * each names the stores whose cleanup must be evidenced before its deletion may
 * be reported complete, and the reviewed set is pinned here so that any change
 * to it is an explicit, reviewable diff rather than a silent edit of a data
 * table. The proof is pure: subjects, executors, periods and the clock are
 * disposable fixtures, and no database, executor, deletion or store is involved.
 */

/** The reviewed per-category policy, stated independently of the implementation. */
const REVIEWED_POLICY: Readonly<Record<RetentionCategory, readonly CleanupCoverageKind[]>> = {
  messages: ['primary', 'index', 'cache', 'replica'],
  contexts: ['primary', 'runtime_state', 'cache'],
  native_transcripts: ['runtime_state', 'cache'],
  receipts: ['primary', 'index'],
  artifacts: ['primary', 'object_version', 'cache', 'replica'],
  memory: ['primary', 'index', 'cache'],
  logs: ['primary', 'index'],
  backups: [],
}

const NOW = '2026-10-09T00:00:00.000Z'
const ANCHOR = '2026-01-01T00:00:00.000Z'
const DELETE_AT = '2026-10-01T00:00:00.000Z'
const READ_AT = '2026-10-02T00:00:00.000Z'
const SUBJECT = 'fixture-policy-subject'
const EXECUTOR = 'fixture-policy-executor'
const REQUEST = 'fixture-policy-request'

const TRUSTED: ReadonlyMap<string, TrustedCleanupExecutor> = new Map([
  [EXECUTOR, { authorizedFrom: ANCHOR, authorizedUntil: null, revokedAt: null }],
])

const EXPIRED_PERIODS = parseRetentionPeriods(
  Object.fromEntries(RETENTION_CATEGORIES.map((category) => [category, 30]))
)

function candidate(category: RetentionCategory): RetentionCandidate {
  return {
    activeReferenceCount: 0,
    anchorAt: ANCHOR,
    authorization: {
      expiresAt: '2027-01-01T00:00:00.000Z',
      grantedAt: ANCHOR,
      id: REQUEST,
      revokedAt: null,
    },
    category,
    holds: [],
    reconciliationOpen: false,
    subjectId: SUBJECT,
  }
}

function receipt(
  category: RetentionCategory,
  coverage: CleanupCoverageKind,
  operation: CleanupReceiptOperation,
  outcome: CleanupReceiptOutcome,
  observedAt: string,
  overrides: Partial<CleanupReceipt> = {}
): CleanupReceipt {
  return {
    category,
    coverage,
    executorId: EXECUTOR,
    observedAt,
    operation,
    outcome,
    residualCount: 0,
    requestId: REQUEST,
    subjectId: SUBJECT,
    ...overrides,
  }
}

/** A completed delete followed by a zero-residual read check for each store. */
function verifiedReceipts(
  category: RetentionCategory,
  coverages: readonly CleanupCoverageKind[] = REVIEWED_POLICY[category]
): CleanupReceipt[] {
  return coverages.flatMap((coverage) => [
    receipt(category, coverage, 'delete', 'completed', DELETE_AT),
    receipt(category, coverage, 'read_check', 'completed', READ_AT),
  ])
}

function inventoryFor(
  category: RetentionCategory,
  coverages: readonly CleanupCoverageKind[] = REVIEWED_POLICY[category]
): RetentionCoverageInventory {
  return Object.fromEntries(coverages.map((coverage) => [coverage, [EXECUTOR]]))
}

function inputFor(
  category: RetentionCategory,
  overrides: Partial<RetentionEvaluationInput> = {}
): RetentionEvaluationInput {
  return {
    candidate: candidate(category),
    coverageInventory: inventoryFor(category),
    now: NOW,
    periods: EXPIRED_PERIODS,
    receipts: verifiedReceipts(category),
    trustedExecutors: TRUSTED,
    ...overrides,
  }
}

function evaluate(category: RetentionCategory, overrides: Partial<RetentionEvaluationInput> = {}) {
  return evaluateRetentionDeletion(inputFor(category, overrides))
}

describe('the retention policy set is total over the categories', () => {
  test('every category resolves to exactly one policy, and every store it names is known', () => {
    expect([...RETENTION_CATEGORIES].toSorted()).toEqual(Object.keys(REVIEWED_POLICY).toSorted())
    for (const category of RETENTION_CATEGORIES) {
      const rule = retentionCategoryRule(category)
      expect(rule.requiredCoverage).toEqual(REVIEWED_POLICY[category])
      for (const coverage of rule.requiredCoverage) {
        expect(CLEANUP_COVERAGE_KINDS).toContain(coverage)
      }
      expect(retentionCategoryRule(category)).toBe(rule)
    }
  })

  test('the reviewed per-category policy is the one the gate uses', () => {
    for (const category of RETENTION_CATEGORIES) {
      expect(RETENTION_COVERAGE_RULES[category].requiredCoverage).toEqual(REVIEWED_POLICY[category])
    }
    // Backups are removed by backup expiry, never per subject.
    expect(RETENTION_COVERAGE_RULES.backups.eventualBackupExpiry).toBe(true)
    for (const category of RETENTION_CATEGORIES) {
      if (category === 'backups') continue
      expect(RETENTION_COVERAGE_RULES[category].eventualBackupExpiry).toBe(false)
    }
  })

  test('a category without a policy is refused with a typed code, never defaulted', () => {
    expect(() => retentionCategoryRule('checkpoints')).toThrow(RetentionPolicyError)
    try {
      retentionCategoryRule('checkpoints')
      expect.unreachable()
    } catch (error) {
      expect((error as RetentionPolicyError).code).toBe('invalid_candidate')
    }
    expect(() => retentionCategoryRule('')).toThrow(RetentionPolicyError)
  })

  test('a malformed evaluation input is refused with a typed code, never a crash', () => {
    const cases: ReadonlyArray<Readonly<{ input: unknown; code: string }>> = [
      {
        code: 'invalid_receipt',
        input: inputFor('messages', { receipts: 'not-a-list' as never }),
      },
      {
        code: 'invalid_input',
        input: inputFor('messages', { trustedExecutors: {} as never }),
      },
      { code: 'invalid_periods', input: inputFor('messages', { periods: null as never }) },
      { code: 'invalid_candidate', input: inputFor('messages', { candidate: null as never }) },
    ]
    for (const { code, input } of cases) {
      let raised: unknown
      try {
        evaluateRetentionDeletion(input as RetentionEvaluationInput)
      } catch (error) {
        raised = error
      }
      expect(raised).toBeInstanceOf(RetentionPolicyError)
      expect((raised as RetentionPolicyError).code).toBe(code)
    }
  })
})

describe('each category gates its own deletion on its own stores', () => {
  test('complete trusted evidence verifies the category it belongs to', () => {
    for (const category of RETENTION_CATEGORIES) {
      const decision = evaluate(category)
      if (category === 'backups') {
        expect(decision).toEqual({ outcome: 'pending', blockers: [{ kind: 'backup_expiry' }] })
        continue
      }
      expect(decision).toEqual({
        outcome: 'verified_complete',
        coverage: REVIEWED_POLICY[category],
      })
    }
  })

  test('one missing store keeps the whole category pending', () => {
    for (const category of RETENTION_CATEGORIES) {
      if (category === 'backups') continue
      for (const missing of REVIEWED_POLICY[category]) {
        const decision = evaluate(category, {
          receipts: verifiedReceipts(category).filter((r) => r.coverage !== missing),
        })
        expect(decision.outcome).toBe('pending')
        if (decision.outcome !== 'pending') continue
        expect(decision.blockers).toContainEqual({
          kind: 'coverage',
          coverage: missing,
          reason: 'coverage_incomplete',
        })
      }
    }
  })

  test('an offline store keeps the category pending and never verified', () => {
    for (const category of RETENTION_CATEGORIES) {
      if (category === 'backups') continue
      const [first] = REVIEWED_POLICY[category]
      const receipts = verifiedReceipts(category).map((r) =>
        r.coverage === first && r.operation === 'delete'
          ? receipt(category, first, 'delete', 'unreachable', DELETE_AT)
          : r
      )
      const decision = evaluate(category, { receipts })
      expect(decision.outcome).toBe('pending')
      if (decision.outcome !== 'pending') continue
      expect(decision.blockers).toContainEqual({
        kind: 'coverage',
        coverage: first,
        reason: 'executor_unreachable',
      })
    }
  })

  test('an incomplete store inventory keeps the category pending', () => {
    for (const category of RETENTION_CATEGORIES) {
      if (category === 'backups') continue
      const [first] = REVIEWED_POLICY[category]
      const inventory = inventoryFor(category)
      delete (inventory as Record<string, string[]>)[first]
      const decision = evaluate(category, { coverageInventory: inventory })
      expect(decision.outcome).toBe('pending')
    }
  })

  test("another category's evidence never verifies this category", () => {
    for (const category of RETENTION_CATEGORIES) {
      if (category === 'backups') continue
      const foreign = category === 'logs' ? 'memory' : 'logs'
      const receipts = verifiedReceipts(category).map((r) => ({ ...r, category: foreign }))
      const decision = evaluate(category, { receipts })
      expect(decision.outcome).not.toBe('verified_complete')
    }
  })

  test('an unset period refuses every category, including the ones with no stores', () => {
    for (const category of RETENTION_CATEGORIES) {
      const decision = evaluate(category, { periods: UNSET_RETENTION_PERIODS })
      expect(decision).toEqual({ outcome: 'refused', reason: 'policy_unset' })
    }
  })
})
