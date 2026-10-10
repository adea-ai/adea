import { describe, expect, test } from 'bun:test'

import {
  evaluateRetentionDeletion,
  parseRetentionPeriods,
  recordCleanupReceipt,
  RETENTION_COVERAGE_RULES,
  RetentionPolicyError,
  UNSET_RETENTION_PERIODS,
  type CleanupCoverageKind,
  type CleanupReceipt,
  type CleanupReceiptOperation,
  type CleanupReceiptOutcome,
  type RetentionCandidate,
  type TrustedCleanupExecutor,
} from '../../src/retention-policy'

/**
 * Receipt-generation isolation for #1243. Each case isolates one way evidence
 * can answer the wrong question: observed too early or too late, ordered
 * ambiguously, or bound to another subject, category, or deletion generation.
 * Fixtures are disposable and the period config is test-only.
 */

const NOW = '2026-10-09T00:00:00.000Z'
const ANCHOR = '2026-01-01T00:00:00.000Z'
const GRANTED = '2026-10-05T00:00:00.000Z'
const GENERATION = 'fixture-generation-2'
const SUBJECT = 'fixture-subject-iso'
const EXECUTOR = 'fixture-executor-iso'
const T = '2026-10-06T12:00:00.000Z'
const T_AFTER = '2026-10-06T12:00:00.001Z'
const DAY_PERIODS = parseRetentionPeriods(
  Object.fromEntries(Object.keys(UNSET_RETENTION_PERIODS).map((category) => [category, 1]))
)
const EXECUTORS: ReadonlyMap<string, TrustedCleanupExecutor> = new Map([
  [
    EXECUTOR,
    { authorizedFrom: '2026-01-01T00:00:00.000Z', authorizedUntil: null, revokedAt: null },
  ],
])
const required = RETENTION_COVERAGE_RULES.messages.requiredCoverage

function receipt(
  coverage: CleanupCoverageKind,
  operation: CleanupReceiptOperation,
  outcome: CleanupReceiptOutcome,
  observedAt: string,
  overrides: Partial<CleanupReceipt> = {}
): CleanupReceipt {
  return {
    category: 'messages',
    coverage,
    executorId: EXECUTOR,
    observedAt,
    operation,
    outcome,
    requestId: GENERATION,
    residualCount: 0,
    subjectId: SUBJECT,
    ...overrides,
  }
}

function candidate(overrides: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return {
    activeReferenceCount: 0,
    anchorAt: ANCHOR,
    authorization: {
      expiresAt: '2027-01-01T00:00:00.000Z',
      grantedAt: GRANTED,
      id: GENERATION,
      revokedAt: null,
    },
    category: 'messages',
    holds: [],
    reconciliationOpen: false,
    subjectId: SUBJECT,
    ...overrides,
  }
}

function decide(receipts: readonly CleanupReceipt[], overrides: Partial<RetentionCandidate> = {}) {
  return evaluateRetentionDeletion({
    candidate: candidate(overrides),
    now: NOW,
    periods: DAY_PERIODS,
    receipts,
    trustedExecutors: EXECUTORS,
  })
}

/** Every required coverage kind verified by a delete at `deleteAt` and a read at `readAt`. */
function verifiedPairs(deleteAt: string, readAt: string): CleanupReceipt[] {
  return required.flatMap((coverage) => [
    receipt(coverage, 'delete', 'completed', deleteAt),
    receipt(coverage, 'read_check', 'completed', readAt),
  ])
}

function pendingFor(
  coverages: readonly CleanupCoverageKind[],
  reason: 'coverage_incomplete' | 'ambiguous_order'
) {
  return {
    blockers: coverages.map((coverage) => ({ coverage, kind: 'coverage', reason })),
    outcome: 'pending',
  }
}

/** The reason the decision blocks one coverage kind, or undefined when that kind is not blocked. */
function blockerFor(decision: ReturnType<typeof decide>, coverage: CleanupCoverageKind) {
  if (decision.outcome !== 'pending') return undefined
  const found = decision.blockers.find(
    (blocker) => blocker.kind === 'coverage' && blocker.coverage === coverage
  )
  return found && found.kind === 'coverage' ? found.reason : undefined
}

describe('stale and future observations never answer the current generation', () => {
  test('a delete and read observed before the generation was granted do not count', () => {
    const stale = '2026-10-04T23:59:59.999Z'
    expect(decide(verifiedPairs(stale, stale))).toEqual({ outcome: 'cleanup_ready' })
  })

  test('an observation exactly at the grant instant is inside the window', () => {
    expect(decide(verifiedPairs(GRANTED, T))).toEqual({
      outcome: 'verified_complete',
      coverage: required,
    })
  })

  test('an observation one millisecond before the grant is outside the window', () => {
    const justBefore = '2026-10-04T23:59:59.999Z'
    expect(decide([receipt('primary', 'delete', 'completed', justBefore)])).toEqual({
      outcome: 'cleanup_ready',
    })
  })

  test('future-dated pairs never verify, and a valid pair does not inherit a future read', () => {
    const future = '2026-10-20T00:00:00.000Z'
    expect(decide(verifiedPairs(future, future))).toEqual({ outcome: 'cleanup_ready' })
    const validDelete = required.map((coverage) => receipt(coverage, 'delete', 'completed', T))
    const futureRead = required.map((coverage) =>
      receipt(coverage, 'read_check', 'completed', '2026-10-20T00:00:00.000Z')
    )
    expect(decide([...validDelete, ...futureRead])).toEqual(
      pendingFor(required, 'coverage_incomplete')
    )
  })

  test('recording refuses future evidence and accepts an observation exactly at now', () => {
    const ok = receipt('primary', 'delete', 'completed', NOW)
    expect(recordCleanupReceipt(ok, EXECUTORS, NOW).observedAt).toBe(NOW)
    const future = receipt('primary', 'delete', 'completed', '2026-10-09T00:00:00.001Z')
    expect(() => recordCleanupReceipt(future, EXECUTORS, NOW)).toThrow(RetentionPolicyError)
    expect(() => recordCleanupReceipt(future, EXECUTORS, NOW)).toThrow('future_receipt')
  })
})

describe('equal-time conflicts are ambiguous in either order', () => {
  const orders: Array<[string, (a: CleanupReceipt, b: CleanupReceipt) => CleanupReceipt[]]> = [
    ['clean first', (a, b) => [a, b]],
    ['conflict first', (a, b) => [b, a]],
  ]

  for (const [label, order] of orders) {
    test(`conflicting reads at the same instant, ${label}, are ambiguous`, () => {
      const clean = receipt('primary', 'read_check', 'completed', T_AFTER)
      const residual = receipt('primary', 'read_check', 'completed', T_AFTER, { residualCount: 2 })
      const receipts = [receipt('primary', 'delete', 'completed', T), ...order(clean, residual)]
      expect(blockerFor(decide(receipts), 'primary')).toBe('ambiguous_order')
    })

    test(`conflicting deletes at the same instant, ${label}, are ambiguous`, () => {
      const completed = receipt('primary', 'delete', 'completed', T)
      const failed = receipt('primary', 'delete', 'failed', T)
      const receipts = [
        ...order(completed, failed),
        receipt('primary', 'read_check', 'completed', T_AFTER),
      ]
      expect(blockerFor(decide(receipts), 'primary')).toBe('ambiguous_order')
    })
  }

  test('identical duplicates at the same instant are not a conflict', () => {
    const duplicate = receipt('primary', 'read_check', 'completed', T_AFTER)
    expect(
      decide([
        receipt('primary', 'delete', 'completed', T),
        duplicate,
        { ...duplicate, executorId: EXECUTOR },
        ...required
          .filter((coverage) => coverage !== 'primary')
          .flatMap((coverage) => [
            receipt(coverage, 'delete', 'completed', T),
            receipt(coverage, 'read_check', 'completed', T_AFTER),
          ]),
      ])
    ).toEqual({ outcome: 'verified_complete', coverage: required })
  })
})

describe('a verifying read must be strictly after its delete', () => {
  test('a read strictly before the delete does not verify', () => {
    expect(decide(verifiedPairs(T, '2026-10-06T11:59:59.999Z'))).toEqual(
      pendingFor(required, 'coverage_incomplete')
    )
  })

  test('a read at exactly the delete instant does not verify', () => {
    expect(decide(verifiedPairs(T, T))).toEqual(pendingFor(required, 'coverage_incomplete'))
  })

  test('a read one millisecond after the delete verifies', () => {
    expect(decide(verifiedPairs(T, T_AFTER))).toEqual({
      outcome: 'verified_complete',
      coverage: required,
    })
  })

  test('a later delete supersedes an earlier clean read', () => {
    const receipts = required.flatMap((coverage) => [
      receipt(coverage, 'read_check', 'completed', '2026-10-06T10:00:00.000Z'),
      receipt(coverage, 'delete', 'completed', T),
    ])
    expect(decide(receipts)).toEqual(pendingFor(required, 'coverage_incomplete'))
  })
})

describe('subject, generation, and category mismatches stay isolated per receipt', () => {
  test('a receipt for another subject, generation, or category never answers this coverage', () => {
    const others: Array<Partial<CleanupReceipt>> = [
      { subjectId: 'fixture-other-subject' },
      { requestId: 'fixture-generation-1' },
      { category: 'logs' },
    ]
    for (const other of others) {
      const receipts = [
        ...verifiedPairs(T, T_AFTER).filter((item) => item.coverage !== 'replica'),
        receipt('replica', 'delete', 'completed', T, other),
        receipt('replica', 'read_check', 'completed', T_AFTER, other),
      ]
      expect(decide(receipts)).toEqual(pendingFor(['replica'], 'coverage_incomplete'))
    }
  })

  test('recording refuses evidence that does not name its category and generation', () => {
    const bare = { ...receipt('primary', 'delete', 'completed', T) }
    for (const missing of ['category', 'requestId']) {
      const value: Record<string, unknown> = { ...bare }
      delete value[missing]
      expect(() => recordCleanupReceipt(value, EXECUTORS, NOW)).toThrow('invalid_receipt')
    }
  })
})
