import { describe, expect, test } from 'bun:test'

import {
  CLEANUP_COVERAGE_KINDS,
  evaluateRetentionDeletion,
  MAX_RETENTION_PERIOD_DAYS,
  parseRetentionPeriods,
  RETENTION_CATEGORIES,
  RETENTION_COVERAGE_RULES,
  RetentionPolicyError,
  recordCleanupReceipt,
  UNSET_RETENTION_PERIODS,
  type CleanupCoverageKind,
  type CleanupReceipt,
  type CleanupReceiptOperation,
  type CleanupReceiptOutcome,
  type RetentionCandidate,
  type RetentionCategory,
  type RetentionEvaluationInput,
  type RetentionPeriods,
} from '../../src/retention-policy'

/**
 * Pure gate suites for M18.02 (#1221). All subjects, executors, holds, periods
 * and the clock are disposable fixtures. No database, executor or deletion is
 * involved.
 */

const NOW = '2026-10-09T00:00:00.000Z'
const ANCHOR = '2026-01-01T00:00:00.000Z'
const EARLY = '2026-10-01T00:00:00.000Z'
const LATER = '2026-10-02T00:00:00.000Z'
const DAY = 86_400_000
const SUBJECT = 'fixture-subject-1'
const CLOUD = 'fixture-cloud-executor'
const NATIVE = 'fixture-native-executor'
const TRUSTED: ReadonlySet<string> = new Set([CLOUD, NATIVE])

const EVERY_CATEGORY_EXPIRED = parseRetentionPeriods(
  Object.fromEntries(RETENTION_CATEGORIES.map((category) => [category, 30]))
)

function periods(overrides: Partial<Record<RetentionCategory, number | null>>): RetentionPeriods {
  return parseRetentionPeriods({ ...UNSET_RETENTION_PERIODS, ...overrides })
}

function candidate(overrides: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return {
    category: 'messages',
    subjectId: SUBJECT,
    anchorAt: ANCHOR,
    holds: [],
    sharedReferenceCount: 0,
    reconciliationOpen: false,
    ...overrides,
  }
}

function receipt(
  coverage: CleanupCoverageKind,
  operation: CleanupReceiptOperation,
  outcome: CleanupReceiptOutcome,
  observedAt: string,
  overrides: Partial<CleanupReceipt> = {}
): CleanupReceipt {
  return {
    subjectId: SUBJECT,
    coverage,
    operation,
    outcome,
    residualCount: 0,
    executorId: CLOUD,
    observedAt,
    ...overrides,
  }
}

/** A completed delete followed by a zero-residual read check for each coverage kind. */
function verifiedReceipts(
  coverages: readonly CleanupCoverageKind[],
  overrides: Partial<CleanupReceipt> = {}
): CleanupReceipt[] {
  return coverages.flatMap((coverage) => [
    receipt(coverage, 'delete', 'completed', EARLY, overrides),
    receipt(coverage, 'read_check', 'completed', LATER, overrides),
  ])
}

function evaluate(overrides: Partial<RetentionEvaluationInput> = {}) {
  return evaluateRetentionDeletion({
    candidate: candidate(),
    periods: EVERY_CATEGORY_EXPIRED,
    receipts: [],
    trustedExecutorIds: TRUSTED,
    now: NOW,
    ...overrides,
  })
}

describe('retention periods are explicit and fail closed', () => {
  test('unset periods refuse deletion in every category, even when expired and unheld', () => {
    for (const category of RETENTION_CATEGORIES) {
      expect(
        evaluate({
          candidate: candidate({ category }),
          periods: UNSET_RETENTION_PERIODS,
        })
      ).toEqual({ outcome: 'refused', reason: 'policy_unset' })
    }
  })

  test('parses explicit nulls and bounded whole-day periods only', () => {
    expect(parseRetentionPeriods(UNSET_RETENTION_PERIODS)).toEqual(UNSET_RETENTION_PERIODS)
    expect(Object.isFrozen(parseRetentionPeriods(UNSET_RETENTION_PERIODS))).toBe(true)
    const valid = periods({ messages: 1, logs: MAX_RETENTION_PERIOD_DAYS })
    expect(valid.messages).toBe(1)
    expect(valid.logs).toBe(MAX_RETENTION_PERIOD_DAYS)
  })

  test('refuses missing, extra, non-integer, zero, negative and oversized periods', () => {
    const { backups: _backups, ...missing } = UNSET_RETENTION_PERIODS
    const invalid: unknown[] = [
      null,
      [],
      'thirty',
      missing,
      { ...UNSET_RETENTION_PERIODS, unknown: 30 },
      { ...UNSET_RETENTION_PERIODS, messages: 0 },
      { ...UNSET_RETENTION_PERIODS, messages: -1 },
      { ...UNSET_RETENTION_PERIODS, messages: 1.5 },
      { ...UNSET_RETENTION_PERIODS, messages: '30' },
      { ...UNSET_RETENTION_PERIODS, messages: MAX_RETENTION_PERIOD_DAYS + 1 },
      { ...UNSET_RETENTION_PERIODS, messages: undefined },
    ]
    for (const value of invalid) {
      try {
        parseRetentionPeriods(value)
        throw new Error('expected refusal')
      } catch (error) {
        expect(error).toBeInstanceOf(RetentionPolicyError)
        expect((error as RetentionPolicyError).code).toBe('invalid_periods')
      }
    }
  })

  test('a zero or fractional period passed directly is refused rather than treated as expired', () => {
    for (const messages of [0, 1.5, Number.NaN]) {
      expect(() =>
        evaluate({ periods: { ...EVERY_CATEGORY_EXPIRED, messages } as RetentionPeriods })
      ).toThrow(RetentionPolicyError)
    }
  })
})

describe('holds, periods, shared references and reconciliation refuse deletion', () => {
  test('an active hold refuses deletion even after the period and with verified cleanup', () => {
    const verified = verifiedReceipts(RETENTION_COVERAGE_RULES.messages.requiredCoverage)
    expect(
      evaluate({
        candidate: candidate({ holds: [{ id: 'fixture-hold-1', releasedAt: null }] }),
        receipts: verified,
      })
    ).toEqual({ outcome: 'refused', reason: 'hold_active' })
  })

  test('a released hold does not block, while a hold released in the future still does', () => {
    const released = candidate({
      holds: [{ id: 'fixture-hold-1', releasedAt: '2026-09-01T00:00:00.000Z' }],
    })
    expect(evaluate({ candidate: released }).outcome).toBe('cleanup_ready')
    const releasingLater = candidate({
      holds: [{ id: 'fixture-hold-1', releasedAt: '2026-10-20T00:00:00.000Z' }],
    })
    expect(evaluate({ candidate: releasingLater })).toEqual({
      outcome: 'refused',
      reason: 'hold_active',
    })
  })

  test('the period boundary is inclusive of the expiry instant', () => {
    const thirtyDays = periods({ messages: 30 })
    const expiry = new Date(Date.parse(ANCHOR) + 30 * DAY).toISOString()
    const justBefore = new Date(Date.parse(expiry) - 1).toISOString()
    expect(evaluate({ periods: thirtyDays, now: justBefore })).toEqual({
      outcome: 'refused',
      reason: 'retention_period_running',
    })
    expect(evaluate({ periods: thirtyDays, now: expiry })).toEqual({ outcome: 'cleanup_ready' })
  })

  test('shared references and open reconciliation refuse deletion', () => {
    expect(
      evaluate({
        candidate: candidate({ category: 'artifacts', sharedReferenceCount: 2 }),
      })
    ).toEqual({ outcome: 'refused', reason: 'shared_reference_retained' })
    expect(
      evaluate({
        candidate: candidate({ category: 'receipts', reconciliationOpen: true }),
      })
    ).toEqual({ outcome: 'refused', reason: 'reconciliation_open' })
  })

  test('refusal ordering: hold wins over a running period, period wins over sharing', () => {
    const thirtyDays = periods({ messages: 30 })
    expect(
      evaluate({
        periods: thirtyDays,
        now: EARLY,
        candidate: candidate({
          holds: [{ id: 'fixture-hold-1', releasedAt: null }],
          sharedReferenceCount: 1,
        }),
      })
    ).toEqual({ outcome: 'refused', reason: 'hold_active' })
    expect(
      evaluate({
        periods: thirtyDays,
        now: ANCHOR,
        candidate: candidate({ sharedReferenceCount: 1 }),
      })
    ).toEqual({ outcome: 'refused', reason: 'retention_period_running' })
  })
})

describe('trusted cleanup gates deletion', () => {
  test('no receipts means cleanup may be dispatched, not that deletion is complete', () => {
    expect(evaluate()).toEqual({ outcome: 'cleanup_ready' })
  })

  test('verified complete only when every required coverage kind has a trusted delete and zero-residual read check', () => {
    const required = RETENTION_COVERAGE_RULES.messages.requiredCoverage
    expect(evaluate({ receipts: verifiedReceipts(required) })).toEqual({
      outcome: 'verified_complete',
      coverage: ['primary', 'index', 'cache', 'replica'],
    })
  })

  test('a read check before the delete does not verify', () => {
    const required = RETENTION_COVERAGE_RULES.messages.requiredCoverage
    const receipts = required.flatMap((coverage) => [
      receipt(coverage, 'read_check', 'completed', EARLY),
      receipt(coverage, 'delete', 'completed', LATER),
    ])
    expect(evaluate({ receipts })).toEqual({
      outcome: 'pending',
      blockers: required.map((coverage) => ({
        kind: 'coverage',
        coverage,
        reason: 'coverage_incomplete',
      })),
    })
  })

  test('receipts from untrusted executors never count toward verification', () => {
    const required = RETENTION_COVERAGE_RULES.messages.requiredCoverage
    const untrusted = verifiedReceipts(required, { executorId: 'fixture-rogue-executor' })
    expect(evaluate({ receipts: untrusted })).toEqual({ outcome: 'cleanup_ready' })
  })

  test('receipts for another subject do not verify this subject', () => {
    const required = RETENTION_COVERAGE_RULES.messages.requiredCoverage
    const other = verifiedReceipts(required, { subjectId: 'fixture-subject-2' })
    expect(evaluate({ receipts: other })).toEqual({ outcome: 'cleanup_ready' })
  })

  test('an offline native executor keeps native transcript deletion pending and never verified', () => {
    const receipts = [
      receipt('runtime_state', 'delete', 'unreachable', EARLY, { executorId: NATIVE }),
      receipt('cache', 'delete', 'completed', EARLY),
      receipt('cache', 'read_check', 'completed', LATER),
    ]
    expect(
      evaluate({
        candidate: candidate({ category: 'native_transcripts' }),
        receipts,
      })
    ).toEqual({
      outcome: 'pending',
      blockers: [{ kind: 'coverage', coverage: 'runtime_state', reason: 'executor_unreachable' }],
    })
  })

  test('an in-progress cleanup reports pending, not verified', () => {
    const receipts = [receipt('primary', 'delete', 'in_progress', EARLY)]
    expect(
      evaluate({
        candidate: candidate({ category: 'logs' }),
        receipts,
      })
    ).toEqual({
      outcome: 'pending',
      blockers: [
        { kind: 'coverage', coverage: 'primary', reason: 'cleanup_in_progress' },
        { kind: 'coverage', coverage: 'index', reason: 'coverage_incomplete' },
      ],
    })
  })

  test('a failed delete or residual data refuses deletion as cleanup_failed', () => {
    const required = RETENTION_COVERAGE_RULES.messages.requiredCoverage
    const failedDelete = [receipt('primary', 'delete', 'failed', EARLY)]
    expect(evaluate({ receipts: failedDelete })).toEqual({
      outcome: 'refused',
      reason: 'cleanup_failed',
    })
    const residual = verifiedReceipts(required).map((item) =>
      item.operation === 'read_check' && item.coverage === 'cache'
        ? { ...item, residualCount: 3 }
        : item
    )
    expect(evaluate({ receipts: residual })).toEqual({
      outcome: 'refused',
      reason: 'cleanup_failed',
    })
  })

  test('a later successful retry supersedes an earlier failed delete', () => {
    const receipts = [
      receipt('primary', 'delete', 'failed', EARLY),
      receipt('primary', 'delete', 'completed', LATER),
      receipt('primary', 'read_check', 'completed', '2026-10-03T00:00:00.000Z'),
    ]
    expect(
      evaluate({
        candidate: candidate({ category: 'logs' }),
        receipts,
      })
    ).toEqual({
      outcome: 'pending',
      blockers: [{ kind: 'coverage', coverage: 'index', reason: 'coverage_incomplete' }],
    })
  })

  test('backups never verify per subject; they remain pending on backup expiry after every other gate', () => {
    expect(evaluate({ candidate: candidate({ category: 'backups' }) })).toEqual({
      outcome: 'pending',
      blockers: [{ kind: 'backup_expiry' }],
    })
    expect(
      evaluate({
        candidate: candidate({
          category: 'backups',
          holds: [{ id: 'fixture-hold-2', releasedAt: null }],
        }),
      })
    ).toEqual({ outcome: 'refused', reason: 'hold_active' })
    expect(
      evaluate({
        candidate: candidate({ category: 'backups' }),
        periods: UNSET_RETENTION_PERIODS,
      })
    ).toEqual({ outcome: 'refused', reason: 'policy_unset' })
  })

  test('decisions never echo subject identifiers or timestamps', () => {
    const decision = evaluate({
      candidate: candidate({ sharedReferenceCount: 1 }),
      receipts: [],
    })
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toContain(SUBJECT)
    expect(serialized).not.toContain(ANCHOR)
  })
})

describe('recording cleanup receipts', () => {
  test('records a trusted receipt as a frozen, normalized value', () => {
    const recorded = recordCleanupReceipt(
      { ...receipt('primary', 'delete', 'completed', EARLY), extra: 'ignored' },
      TRUSTED
    )
    expect(recorded).toEqual(receipt('primary', 'delete', 'completed', EARLY))
    expect(Object.isFrozen(recorded)).toBe(true)
  })

  test('rejects an untrusted executor, and malformed receipts', () => {
    const cases: [unknown, string][] = [
      [
        receipt('primary', 'delete', 'completed', EARLY, { executorId: 'fixture-rogue-executor' }),
        'untrusted_executor',
      ],
      [
        { ...receipt('primary', 'delete', 'completed', EARLY), coverage: 'everything' },
        'invalid_receipt',
      ],
      [
        { ...receipt('primary', 'delete', 'completed', EARLY), operation: 'purge' },
        'invalid_receipt',
      ],
      [{ ...receipt('primary', 'delete', 'completed', EARLY), outcome: 'done' }, 'invalid_receipt'],
      [
        { ...receipt('primary', 'delete', 'completed', EARLY), residualCount: -1 },
        'invalid_receipt',
      ],
      [
        { ...receipt('primary', 'delete', 'completed', EARLY), residualCount: 0.5 },
        'invalid_receipt',
      ],
      [
        { ...receipt('primary', 'delete', 'completed', EARLY), observedAt: 'yesterday' },
        'invalid_receipt',
      ],
      [
        { ...receipt('primary', 'delete', 'completed', EARLY), subjectId: 'has space' },
        'invalid_receipt',
      ],
      [null, 'invalid_receipt'],
    ]
    for (const [value, code] of cases) {
      try {
        recordCleanupReceipt(value, TRUSTED)
        throw new Error('expected refusal')
      } catch (error) {
        expect((error as RetentionPolicyError).code).toBe(code)
        expect(String((error as Error).message)).toBe(code)
      }
    }
  })

  test('a malformed receipt in the evaluation input is refused, not silently ignored', () => {
    expect(() => evaluate({ receipts: [{ subjectId: SUBJECT }] })).toThrow(RetentionPolicyError)
  })
})

describe('candidate validation', () => {
  test('refuses malformed categories, identifiers, timestamps and holds', () => {
    const invalid: RetentionCandidate[] = [
      candidate({ category: 'unknown' as RetentionCategory }),
      candidate({ subjectId: '' }),
      candidate({ anchorAt: '2026-13-01T00:00:00Z' }),
      candidate({ sharedReferenceCount: -1 }),
      candidate({ holds: [null as never] }),
      candidate({ holds: [{ id: 'fixture-hold-1', releasedAt: 'soon' }] }),
    ]
    for (const value of invalid) {
      try {
        evaluate({ candidate: value })
        throw new Error('expected refusal')
      } catch (error) {
        expect((error as RetentionPolicyError).code).toBe('invalid_candidate')
      }
    }
  })
})

describe('coverage contract', () => {
  test('every category names only known coverage kinds, and native transcripts route through runtime state', () => {
    for (const category of RETENTION_CATEGORIES) {
      for (const coverage of RETENTION_COVERAGE_RULES[category].requiredCoverage) {
        expect(CLEANUP_COVERAGE_KINDS).toContain(coverage)
      }
    }
    expect(RETENTION_COVERAGE_RULES.native_transcripts.requiredCoverage).toContain('runtime_state')
    expect(RETENTION_COVERAGE_RULES.backups.eventualBackupExpiry).toBe(true)
  })
})
