/*
 * Pure presentation models for the #424 resources/usage pane: process rows,
 * usage cards, retained-data breakdown, and metric summaries.
 *
 * Every rule mirrors the host's ownership bar: a process row is actionable
 * (stoppable) only when the host reports a running state on a proven launch
 * record — the pane never decides ownership itself, and an explicit
 * `unknown`/`exited` state renders as inert. Usage rows that carry a typed
 * failure or an `unknown` quantity render as unknown states, never as 0,
 * and `local_transcript_estimate` rows are always labeled as estimates.
 */
import type {
  DevError,
  ProcessRecord,
  ResourceMetric,
  RetainedDataRecord,
  UsageRecord,
  UsageSource,
} from '@adea-ai/types/dev-runtime'

export type ProcessRow = Readonly<{
  record: ProcessRecord
  stoppable: boolean
  stateLabel: string
}>

const STATE_LABELS: Record<ProcessRecord['state'], string> = {
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  exited: 'Exited',
  unknown: 'Identity unproven',
}

/** A row offers a stop control only while the host proves a live, running
 * launch record; `unknown` (PID-replaced), `stopping`, and `exited` do not. */
export function isStoppableProcess(record: ProcessRecord): boolean {
  return record.state === 'running'
}

export function processRows(records: readonly ProcessRecord[]): readonly ProcessRow[] {
  return records
    .map((record) => ({
      record,
      stoppable: isStoppableProcess(record),
      stateLabel: STATE_LABELS[record.state],
    }))
    .toSorted((left, right) => {
      if (left.stoppable !== right.stoppable) return left.stoppable ? -1 : 1
      return left.record.id.localeCompare(right.record.id)
    })
}

export const USAGE_SOURCE_LABELS: Record<UsageSource, string> = {
  official_api: 'Official API',
  harness_protocol: 'Harness protocol',
  local_transcript_estimate: 'Local estimate (not billing truth)',
}

export type UsageCard = Readonly<{
  provider: string
  source: UsageSource
  sourceLabel: string
  confidence: 'authoritative' | 'measured' | 'estimated'
  quantity: string
  quantityIsUnknown: boolean
  unit: string
  accountLabel?: string
  remaining?: string
  failure?: Readonly<{ code: DevError['code']; message: string }>
  /** Declared freshness has passed: rendered as stale, never refreshed away. */
  stale: boolean
  observedAt: string
}>

/** The newest record per provider, mapped into card state. Failure rows and
 * `unknown` quantities are explicit card states. */
export function usageCards(records: readonly UsageRecord[], now: number): readonly UsageCard[] {
  const latestByProvider = new Map<string, UsageRecord>()
  for (const record of records) {
    const existing = latestByProvider.get(record.provider)
    if (existing === undefined || record.observedAt >= existing.observedAt) {
      latestByProvider.set(record.provider, record)
    }
  }
  return [...latestByProvider.values()]
    .toSorted((left, right) => left.provider.localeCompare(right.provider))
    .map((record) => ({
      provider: record.provider,
      source: record.source,
      sourceLabel: USAGE_SOURCE_LABELS[record.source],
      confidence: record.confidence,
      quantity: record.quantity,
      quantityIsUnknown: record.quantity === 'unknown',
      unit: record.unit,
      ...(record.accountLabel !== undefined ? { accountLabel: record.accountLabel } : {}),
      ...(record.remaining !== undefined ? { remaining: record.remaining } : {}),
      ...(record.failure !== undefined
        ? {
            failure: {
              code: record.failure.code,
              message: record.failure.message,
            },
          }
        : {}),
      stale:
        record.expiresAt !== undefined &&
        Number.isFinite(Date.parse(record.expiresAt)) &&
        Date.parse(record.expiresAt) <= now,
      observedAt: record.observedAt,
    }))
}

export type RetainedGroup = Readonly<{
  kind: RetainedDataRecord['kind']
  count: number
  totalBytes: number
  protectedBytes: number
}>

export function retainedGroups(records: readonly RetainedDataRecord[]): readonly RetainedGroup[] {
  const groups = new Map<RetainedDataRecord['kind'], RetainedGroup>()
  for (const record of records) {
    const bytes = Number(record.byteLength)
    const safeBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0
    const existing = groups.get(record.kind)
    const next: RetainedGroup = {
      kind: record.kind,
      count: (existing?.count ?? 0) + 1,
      totalBytes: (existing?.totalBytes ?? 0) + safeBytes,
      protectedBytes: (existing?.protectedBytes ?? 0) + (record.protected ? safeBytes : 0),
    }
    groups.set(record.kind, next)
  }
  return [...groups.values()].toSorted((left, right) => right.totalBytes - left.totalBytes)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

export type MetricSummary = Readonly<{
  cpuPercent?: number
  residentBytes?: string
  sampleCount: number
  lastObservedAt?: string
}>

/** Latest observable values over a session's points. Absent fields render as
 * `unknown` — a missing sample is never displayed as 0%. */
export function metricSummary(points: readonly ResourceMetric[]): MetricSummary {
  let cpuPercent: number | undefined
  let residentBytes: string | undefined
  let lastObservedAt: string | undefined
  for (const point of points) {
    if (point.cpuPercent !== undefined) cpuPercent = point.cpuPercent
    if (point.residentBytes !== undefined) residentBytes = point.residentBytes
    if (lastObservedAt === undefined || point.observedAt >= lastObservedAt) {
      lastObservedAt = point.observedAt
    }
  }
  return {
    ...(cpuPercent !== undefined ? { cpuPercent } : {}),
    ...(residentBytes !== undefined ? { residentBytes } : {}),
    sampleCount: points.length,
    ...(lastObservedAt !== undefined ? { lastObservedAt } : {}),
  }
}
