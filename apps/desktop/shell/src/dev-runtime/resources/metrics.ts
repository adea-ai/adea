// Bounded resource-metric history for #424.
//
// Sampling is pull-based: the resources provider records a point when the
// snapshot/metrics surface samples the supervised processes, never on a
// timer — no always-on telemetry. History is bounded twice (720 points per
// owner and 24 hours, spec defaults) and pruned on both axes. CPU is a delta
// over the monotonic sampler clock between consecutive points for the same
// owner; the first point for an owner carries no cpuPercent (absent, never
// 0). Memory distinguishes the process RSS from descendant aggregates the
// sampler reports separately. Unknowns stay absent/typed — the UI renders
// them as unknown, never as numeric zero.
import type { ResourceMetric } from '../../../../../../packages/types/src/dev-runtime'

export const MAX_POINTS_PER_OWNER = 720
export const HISTORY_WINDOW_MS = 24 * 60 * 60_000

/** What the sampler observed for one process at one instant. `cpuSeconds` is
 * the OS cumulative process CPU time; the store derives percentages from
 * consecutive deltas. */
export type ResourceSample = Readonly<{
  pid: number
  cpuSeconds?: number
  residentBytes?: number
  descendantsResidentBytes?: number
  readBytes?: number
  writeBytes?: number
}>

export type MetricOwner = Readonly<{
  ownerId: string
  processRecordId?: string
  runtimeSessionId?: string
  worktreeId?: string
  generation?: number
}>

export type MetricsHistoryInput = Readonly<{
  now?: () => number
  maxPointsPerOwner?: number
  windowMs?: number
}>

type OwnerHistory = {
  points: ResourceMetric[]
  lastSample: { at: number; cpuSeconds: number } | undefined
}

export type MetricsHistory = Readonly<{
  recordSample(owner: MetricOwner, sample: ResourceSample): void
  list(filter?: {
    runtimeSessionId?: string
    worktreeId?: string
    processRecordId?: string
    fromMs?: number
    toMs?: number
  }): ResourceMetric[]
}>

export function createMetricsHistory(input: MetricsHistoryInput = {}): MetricsHistory {
  const now = input.now ?? Date.now
  const maxPoints = input.maxPointsPerOwner ?? MAX_POINTS_PER_OWNER
  const windowMs = input.windowMs ?? HISTORY_WINDOW_MS
  const owners = new Map<string, OwnerHistory>()

  return {
    recordSample(owner, sample) {
      const at = now()
      let history = owners.get(owner.ownerId)
      if (!history) {
        history = { points: [], lastSample: undefined }
        owners.set(owner.ownerId, history)
      }
      let cpuPercent: number | undefined
      if (
        sample.cpuSeconds !== undefined &&
        history.lastSample !== undefined &&
        at > history.lastSample.at
      ) {
        const deltaSeconds = sample.cpuSeconds - history.lastSample.cpuSeconds
        const elapsedSeconds = (at - history.lastSample.at) / 1000
        if (deltaSeconds >= 0 && elapsedSeconds > 0)
          cpuPercent = (deltaSeconds / elapsedSeconds) * 100
      }
      history.lastSample =
        sample.cpuSeconds !== undefined ? { at, cpuSeconds: sample.cpuSeconds } : history.lastSample
      const point: ResourceMetric = {
        ownerId: owner.ownerId,
        ...(cpuPercent !== undefined ? { cpuPercent } : {}),
        ...(sample.residentBytes !== undefined
          ? { residentBytes: String(sample.residentBytes) }
          : {}),
        ...(sample.readBytes !== undefined ? { readBytes: String(sample.readBytes) } : {}),
        ...(sample.writeBytes !== undefined ? { writeBytes: String(sample.writeBytes) } : {}),
        observedAt: new Date(at).toISOString(),
        confidence: 'measured',
        ...(owner.processRecordId !== undefined ? { processRecordId: owner.processRecordId } : {}),
        ...(owner.runtimeSessionId !== undefined
          ? { runtimeSessionId: owner.runtimeSessionId }
          : {}),
        ...(owner.worktreeId !== undefined ? { worktreeId: owner.worktreeId } : {}),
        ...(owner.generation !== undefined ? { generation: owner.generation } : {}),
      }
      history.points.push(point)
      const horizon = at - windowMs
      history.points = history.points
        .filter((entry) => Date.parse(entry.observedAt) >= horizon)
        .slice(-maxPoints)
    },

    list(filter = {}) {
      const matches: ResourceMetric[] = []
      for (const history of owners.values()) {
        for (const point of history.points) {
          if (
            filter.runtimeSessionId !== undefined &&
            point.runtimeSessionId !== filter.runtimeSessionId
          )
            continue
          if (filter.worktreeId !== undefined && point.worktreeId !== filter.worktreeId) continue
          if (
            filter.processRecordId !== undefined &&
            point.processRecordId !== filter.processRecordId
          )
            continue
          const at = Date.parse(point.observedAt)
          if (filter.fromMs !== undefined && at < filter.fromMs) continue
          if (filter.toMs !== undefined && at > filter.toMs) continue
          matches.push(point)
        }
      }
      return matches.toSorted((left, right) => left.observedAt.localeCompare(right.observedAt))
    },
  }
}
