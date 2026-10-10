/**
 * Retention and trusted-cleanup gate for M18.02 (#1221).
 *
 * Every data category has its own rule: the cleanup coverage kinds that must be
 * verified before deletion may be reported complete, and whether deletion is
 * only eventual (backups). Periods are configuration, not defaults: each one is
 * `null` (unset) until approved, and an unset period refuses every deletion
 * (fail closed). Holds, shared references and open reconciliation refuse
 * deletion even after the period has expired. A subject is verified complete
 * only when, for every required coverage kind, the latest trusted delete
 * receipt completed and a later trusted read check found zero residuals.
 *
 * The functions are pure: candidates, receipts, the trusted executor set, the
 * periods and the clock are injected. Nothing here deletes data, contacts an
 * executor, or persists receipts. Decisions carry only reason and blocker codes,
 * never subject ids, timestamps, locations or content. Trust in an executor id
 * is established by the caller's authenticated boundary, not by this module.
 */

export const RETENTION_CATEGORIES = [
  'messages',
  'contexts',
  'native_transcripts',
  'receipts',
  'artifacts',
  'memory',
  'logs',
  'backups',
] as const

export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number]

export const CLEANUP_COVERAGE_KINDS = [
  'primary',
  'runtime_state',
  'index',
  'cache',
  'object_version',
  'replica',
] as const

export type CleanupCoverageKind = (typeof CLEANUP_COVERAGE_KINDS)[number]

type RetentionRule = {
  readonly requiredCoverage: readonly CleanupCoverageKind[]
  /** Backups are removed by backup expiry, never by per-subject deletion. */
  readonly eventualBackupExpiry: boolean
}

/**
 * Coverage follows REQ 142: primary stores, runtime state, indexes, caches,
 * object versions and asynchronous replicas. Native transcripts live on the
 * executing device, so they are covered through runtime state.
 */
export const RETENTION_COVERAGE_RULES: Readonly<Record<RetentionCategory, RetentionRule>> =
  Object.freeze({
    messages: {
      requiredCoverage: ['primary', 'index', 'cache', 'replica'],
      eventualBackupExpiry: false,
    },
    contexts: {
      requiredCoverage: ['primary', 'runtime_state', 'cache'],
      eventualBackupExpiry: false,
    },
    native_transcripts: {
      requiredCoverage: ['runtime_state', 'cache'],
      eventualBackupExpiry: false,
    },
    receipts: {
      requiredCoverage: ['primary', 'index'],
      eventualBackupExpiry: false,
    },
    artifacts: {
      requiredCoverage: ['primary', 'object_version', 'cache', 'replica'],
      eventualBackupExpiry: false,
    },
    memory: {
      requiredCoverage: ['primary', 'index', 'cache'],
      eventualBackupExpiry: false,
    },
    logs: {
      requiredCoverage: ['primary', 'index'],
      eventualBackupExpiry: false,
    },
    backups: {
      requiredCoverage: [],
      eventualBackupExpiry: true,
    },
  })

/** Retention periods in whole days. `null` means unset and refuses deletion. */
export type RetentionPeriods = Readonly<Record<RetentionCategory, number | null>>

export const UNSET_RETENTION_PERIODS: RetentionPeriods = Object.freeze({
  messages: null,
  contexts: null,
  native_transcripts: null,
  receipts: null,
  artifacts: null,
  memory: null,
  logs: null,
  backups: null,
})

export const MAX_RETENTION_PERIOD_DAYS = 36_500

const DAY_MS = 86_400_000
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

export type RetentionPolicyErrorCode =
  | 'invalid_periods'
  | 'invalid_candidate'
  | 'invalid_receipt'
  | 'untrusted_executor'

export class RetentionPolicyError extends Error {
  constructor(readonly code: RetentionPolicyErrorCode) {
    super(code)
    this.name = 'RetentionPolicyError'
  }
}

function fail(code: RetentionPolicyErrorCode): never {
  throw new RetentionPolicyError(code)
}

function isPeriodDays(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_RETENTION_PERIOD_DAYS
  )
}

function timestampMs(value: unknown, code: RetentionPolicyErrorCode): number {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) fail(code)
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) fail(code)
  return ms
}

function opaqueId(value: unknown, code: RetentionPolicyErrorCode): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) fail(code)
  return value as string
}

function count(value: unknown, code: RetentionPolicyErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code)
  return value as number
}

/**
 * Parse operator-supplied periods. Every category must be present exactly once;
 * each value is `null` (explicitly unset) or a whole number of days in range.
 */
export function parseRetentionPeriods(value: unknown): RetentionPeriods {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('invalid_periods')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== RETENTION_CATEGORIES.length ||
    !RETENTION_CATEGORIES.every((category) => Object.hasOwn(record, category))
  )
    fail('invalid_periods')
  const periods = {} as Record<RetentionCategory, number | null>
  for (const category of RETENTION_CATEGORIES) {
    const period = record[category]
    if (period !== null && !isPeriodDays(period)) fail('invalid_periods')
    periods[category] = period as number | null
  }
  return Object.freeze(periods)
}

export type RetentionHold = {
  readonly id: string
  /** `null` while the hold is active; a timestamp once it has been released. */
  readonly releasedAt: string | null
}

/**
 * One subject in one category. `anchorAt` is the timestamp the retention period
 * runs from. `sharedReferenceCount` counts live references from other scopes,
 * such as an artifact still used elsewhere. `reconciliationOpen` marks an
 * external effect or audit reconciliation that is not yet closed.
 */
export type RetentionCandidate = {
  readonly category: RetentionCategory
  readonly subjectId: string
  readonly anchorAt: string
  readonly holds: readonly RetentionHold[]
  readonly sharedReferenceCount: number
  readonly reconciliationOpen: boolean
}

export type CleanupReceiptOperation = 'delete' | 'read_check'
export type CleanupReceiptOutcome = 'completed' | 'in_progress' | 'unreachable' | 'failed'

/**
 * One result from a cleanup executor for one store coverage kind. A `read_check`
 * must observe `residualCount` zero to verify a completed delete.
 */
export type CleanupReceipt = {
  readonly subjectId: string
  readonly coverage: CleanupCoverageKind
  readonly operation: CleanupReceiptOperation
  readonly outcome: CleanupReceiptOutcome
  readonly residualCount: number
  readonly executorId: string
  readonly observedAt: string
}

const RECEIPT_OPERATIONS: readonly CleanupReceiptOperation[] = ['delete', 'read_check']
const RECEIPT_OUTCOMES: readonly CleanupReceiptOutcome[] = [
  'completed',
  'in_progress',
  'unreachable',
  'failed',
]

function parseReceipt(value: unknown): CleanupReceipt {
  if (typeof value !== 'object' || value === null) fail('invalid_receipt')
  const record = value as Record<string, unknown>
  const { coverage, operation, outcome } = record
  if (
    !CLEANUP_COVERAGE_KINDS.includes(coverage as CleanupCoverageKind) ||
    !RECEIPT_OPERATIONS.includes(operation as CleanupReceiptOperation) ||
    !RECEIPT_OUTCOMES.includes(outcome as CleanupReceiptOutcome)
  )
    fail('invalid_receipt')
  timestampMs(record.observedAt, 'invalid_receipt')
  return Object.freeze({
    subjectId: opaqueId(record.subjectId, 'invalid_receipt'),
    coverage: coverage as CleanupCoverageKind,
    operation: operation as CleanupReceiptOperation,
    outcome: outcome as CleanupReceiptOutcome,
    residualCount: count(record.residualCount, 'invalid_receipt'),
    executorId: opaqueId(record.executorId, 'invalid_receipt'),
    observedAt: record.observedAt as string,
  })
}

/**
 * Record a cleanup receipt from a trusted executor. Receipts from any other
 * executor are rejected and never count toward verification.
 */
export function recordCleanupReceipt(
  value: unknown,
  trustedExecutorIds: ReadonlySet<string>
): CleanupReceipt {
  const receipt = parseReceipt(value)
  if (!trustedExecutorIds.has(receipt.executorId)) fail('untrusted_executor')
  return receipt
}

export type RetentionRefusalReason =
  | 'policy_unset'
  | 'hold_active'
  | 'retention_period_running'
  | 'shared_reference_retained'
  | 'reconciliation_open'
  | 'cleanup_failed'

export type RetentionBlocker =
  | {
      readonly kind: 'coverage'
      readonly coverage: CleanupCoverageKind
      readonly reason: 'executor_unreachable' | 'cleanup_in_progress' | 'coverage_incomplete'
    }
  | { readonly kind: 'backup_expiry' }

export type RetentionDecision =
  | { readonly outcome: 'refused'; readonly reason: RetentionRefusalReason }
  | { readonly outcome: 'pending'; readonly blockers: readonly RetentionBlocker[] }
  | { readonly outcome: 'cleanup_ready' }
  | { readonly outcome: 'verified_complete'; readonly coverage: readonly CleanupCoverageKind[] }

export type RetentionEvaluationInput = {
  readonly candidate: RetentionCandidate
  readonly periods: RetentionPeriods
  readonly receipts: readonly unknown[]
  readonly trustedExecutorIds: ReadonlySet<string>
  readonly now: string
}

function parseCandidate(value: RetentionCandidate): RetentionCandidate {
  if (!RETENTION_CATEGORIES.includes(value.category)) fail('invalid_candidate')
  opaqueId(value.subjectId, 'invalid_candidate')
  timestampMs(value.anchorAt, 'invalid_candidate')
  count(value.sharedReferenceCount, 'invalid_candidate')
  if (typeof value.reconciliationOpen !== 'boolean' || !Array.isArray(value.holds))
    fail('invalid_candidate')
  for (const hold of value.holds) {
    if (typeof hold !== 'object' || hold === null) fail('invalid_candidate')
    opaqueId(hold.id, 'invalid_candidate')
    if (hold.releasedAt !== null) timestampMs(hold.releasedAt, 'invalid_candidate')
  }
  return value
}

function holdIsActive(hold: RetentionHold, nowMs: number): boolean {
  return hold.releasedAt === null || Date.parse(hold.releasedAt) > nowMs
}

function blockedCoverage(
  coverage: CleanupCoverageKind,
  reason: 'executor_unreachable' | 'cleanup_in_progress' | 'coverage_incomplete'
): CoverageState {
  return { state: 'blocked', blocker: { kind: 'coverage', coverage, reason } }
}

type CoverageState =
  | { readonly state: 'verified' }
  | { readonly state: 'failed' }
  | { readonly state: 'blocked'; readonly blocker: RetentionBlocker }

function stateForOutcome(
  outcome: CleanupReceiptOutcome,
  coverage: CleanupCoverageKind
): CoverageState {
  if (outcome === 'in_progress') return blockedCoverage(coverage, 'cleanup_in_progress')
  return blockedCoverage(coverage, 'executor_unreachable')
}

/** The latest trusted delete and the latest read check after it decide one coverage kind. */
function coverageState(
  coverage: CleanupCoverageKind,
  receipts: readonly CleanupReceipt[]
): CoverageState {
  const latest = (operation: CleanupReceiptOperation) =>
    receipts
      .filter((receipt) => receipt.coverage === coverage && receipt.operation === operation)
      .toSorted((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]
  const deletion = latest('delete')
  if (!deletion) return blockedCoverage(coverage, 'coverage_incomplete')
  if (deletion.outcome === 'failed') return { state: 'failed' }
  if (deletion.outcome !== 'completed') return stateForOutcome(deletion.outcome, coverage)
  const read = latest('read_check')
  if (!read || Date.parse(read.observedAt) < Date.parse(deletion.observedAt))
    return blockedCoverage(coverage, 'coverage_incomplete')
  if (read.outcome === 'failed' || (read.outcome === 'completed' && read.residualCount > 0))
    return { state: 'failed' }
  if (read.outcome !== 'completed') return stateForOutcome(read.outcome, coverage)
  return { state: 'verified' }
}

/**
 * Evaluate one deletion candidate in fixed order: unset period, active hold,
 * running period, shared reference, open reconciliation, then cleanup
 * coverage. `cleanup_ready` means cleanup may be dispatched, not that data is
 * gone. Only `verified_complete` supports reporting deletion as complete.
 */
export function evaluateRetentionDeletion(input: RetentionEvaluationInput): RetentionDecision {
  const candidate = parseCandidate(input.candidate)
  const nowMs = timestampMs(input.now, 'invalid_candidate')
  const anchorMs = timestampMs(candidate.anchorAt, 'invalid_candidate')
  const period = input.periods[candidate.category]
  if (period === null) return { outcome: 'refused', reason: 'policy_unset' }
  if (!isPeriodDays(period)) fail('invalid_periods')

  if (candidate.holds.some((hold) => holdIsActive(hold, nowMs)))
    return { outcome: 'refused', reason: 'hold_active' }

  const expiresAtMs = anchorMs + period * DAY_MS
  if (nowMs < expiresAtMs) return { outcome: 'refused', reason: 'retention_period_running' }
  if (candidate.sharedReferenceCount > 0)
    return { outcome: 'refused', reason: 'shared_reference_retained' }
  if (candidate.reconciliationOpen) return { outcome: 'refused', reason: 'reconciliation_open' }

  const rule = RETENTION_COVERAGE_RULES[candidate.category]
  if (rule.eventualBackupExpiry)
    return { outcome: 'pending', blockers: [{ kind: 'backup_expiry' }] }

  const receipts = input.receipts
    .map(parseReceipt)
    .filter(
      (receipt) =>
        receipt.subjectId === candidate.subjectId &&
        input.trustedExecutorIds.has(receipt.executorId)
    )
  if (receipts.length === 0) return { outcome: 'cleanup_ready' }

  const states = rule.requiredCoverage.map((coverage) => coverageState(coverage, receipts))
  if (states.some((state) => state.state === 'failed'))
    return { outcome: 'refused', reason: 'cleanup_failed' }
  const blockers = states.flatMap((state) => (state.state === 'blocked' ? [state.blocker] : []))
  if (blockers.length > 0) return { outcome: 'pending', blockers }
  return { outcome: 'verified_complete', coverage: rule.requiredCoverage }
}
