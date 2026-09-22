// Bounded resource-metric history for #424.
//
// Sampling is pull-based: the resources provider records a point when the
// snapshot/metrics surface samples the supervised processes, never on a timer —
// no always-on telemetry. History is bounded twice (720 points per owner and
// 24 hours, spec defaults) and pruned on both axes. CPU is a delta over the
// monotonic sampler clock between consecutive points for the same owner; the
// first point for an owner carries no cpuPercent (absent, never 0). Memory
// distinguishes the process RSS from descendant aggregates the sampler reports
// separately. Unknowns stay absent/typed — the UI renders them as unknown,
// never as numeric zero.
//
// The full listing is maintained between reads (#596): per pull the snapshot
// used to re-derive it from every retained point (a Date.parse plus a global
// stable sort per point, per pull), so host read cost grew with retained
// history. Points are appended in listing order — the sampler clock is
// monotonic, so each append is at least as new as everything recorded before
// it — and per-owner eviction only ever removes old points. A read therefore
// folds just the delta since the last read and never re-parses or re-sorts
// retained points; per-owner pruning compares stored epoch timestamps instead
// of re-parsing ISO strings. The invariant is self-healing: any non-monotonic
// step of the (injectable) clock, or an un-flushed delta past a bound, makes
// the next unfiltered read fall back to the exact legacy rebuild.
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
  /** Epoch millis parallel to `points` — the sampler clock at record time —
   * so pruning and filtered scans never re-parse the ISO `observedAt`. */
  atMs: number[]
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

/** Bound on the un-flushed listing delta so memory stays bounded even when
 * the unfiltered listing is never read (filtered reads scan owners directly
 * and never fold the delta). Exceeding it forces one exact rebuild. */
const MAX_PENDING_DELTA = 8_192

/** One recorded point waiting to be folded into the maintained listing,
 * carrying its listing key: the sampler clock plus the owner's creation
 * index — exactly the legacy listing's stable order for same-millisecond
 * points (owners iterate in creation order). */
type PendingListingEntry = {
  point: ResourceMetric
  at: number
  ownerSeq: number
}

export function createMetricsHistory(input: MetricsHistoryInput = {}): MetricsHistory {
  const now = input.now ?? Date.now
  const maxPoints = input.maxPointsPerOwner ?? MAX_POINTS_PER_OWNER
  const windowMs = input.windowMs ?? HISTORY_WINDOW_MS
  const owners = new Map<string, OwnerHistory>()
  /** Owner creation order, mirroring the owners Map's insertion order — the
   * legacy listing's tie-break for points sharing an `observedAt`. */
  const ownerSeq = new Map<string, number>()
  let nextOwnerSeq = 0

  // The maintained full listing: live points in the exact legacy order —
  // `observedAt`, then owner creation order. Rebound on change, never mutated
  // after being handed out, so callers hold a listing that stays frozen at
  // what they observed. `cacheAtMs` runs parallel to `orderedCache` so folds
  // and evictions never re-parse ISO strings.
  let orderedCache: ResourceMetric[] = []
  let cacheAtMs: number[] = []
  let pendingAppends: PendingListingEntry[] = []
  let pendingEvictions: ResourceMetric[] = []
  let needsFullRebuild = false
  let lastAppendAt = Number.NEGATIVE_INFINITY

  function noteAppend(entry: PendingListingEntry): void {
    if (entry.at < lastAppendAt) needsFullRebuild = true
    if (entry.at > lastAppendAt) lastAppendAt = entry.at
    // Keep the pending delta itself in listing order: insert after every
    // entry it must follow ((at, ownerSeq) ascending). With a monotonic
    // clock this only walks the tail that shares the millisecond.
    let index = pendingAppends.length
    while (index > 0) {
      const previous = pendingAppends[index - 1]!
      if (
        previous.at < entry.at ||
        (previous.at === entry.at && previous.ownerSeq <= entry.ownerSeq)
      )
        break
      index -= 1
    }
    pendingAppends.splice(index, 0, entry)
    if (pendingAppends.length + pendingEvictions.length > MAX_PENDING_DELTA) {
      pendingAppends = []
      pendingEvictions = []
      needsFullRebuild = true
    }
  }

  /** The exact legacy derivation: all live points collected owner by owner
   * (creation order) and stable-sorted by `observedAt`. The slow path for a
   * broken append-order invariant. */
  function rebuildOrdered(): { points: ResourceMetric[]; atMs: number[] } {
    const all: ResourceMetric[] = []
    for (const history of owners.values()) all.push(...history.points)
    const points = all.toSorted((left, right) => left.observedAt.localeCompare(right.observedAt))
    return { points, atMs: points.map((point) => Date.parse(point.observedAt)) }
  }

  function orderedListing(): ResourceMetric[] {
    if (needsFullRebuild) {
      const rebuilt = rebuildOrdered()
      orderedCache = rebuilt.points
      cacheAtMs = rebuilt.atMs
      pendingAppends = []
    } else if (pendingAppends.length > 0) {
      const lastAt =
        cacheAtMs.length > 0 ? cacheAtMs[cacheAtMs.length - 1]! : Number.NEGATIVE_INFINITY
      const boundaryAt = pendingAppends[0]!.at
      if (boundaryAt > lastAt) {
        // Common case: the delta is strictly newer than everything listed.
        orderedCache = orderedCache.concat(pendingAppends.map((entry) => entry.point))
        cacheAtMs = cacheAtMs.concat(pendingAppends.map((entry) => entry.at))
      } else {
        // A same-millisecond run straddles the fold boundary: merge the
        // cache's trailing equal-at run with the pending delta by listing
        // key, taking the cache run on full-key ties (it holds the earlier
        // records — the legacy stable sort's order).
        let suffixStart = cacheAtMs.length
        while (suffixStart > 0 && cacheAtMs[suffixStart - 1]! >= boundaryAt) suffixStart -= 1
        const mergedPoints: ResourceMetric[] = []
        const mergedAt: number[] = []
        let left = suffixStart
        let right = 0
        while (left < orderedCache.length || right < pendingAppends.length) {
          const cachePoint = orderedCache[left]
          const cacheAt = cacheAtMs[left]
          const pendingEntry = pendingAppends[right]
          const takeLeft =
            pendingEntry === undefined ||
            (cachePoint !== undefined &&
              cacheAt !== undefined &&
              (cacheAt < pendingEntry.at ||
                (cacheAt === pendingEntry.at &&
                  ownerSeq.get(cachePoint.ownerId)! <= pendingEntry.ownerSeq)))
          if (takeLeft) {
            mergedPoints.push(cachePoint!)
            mergedAt.push(cacheAt!)
            left += 1
          } else {
            mergedPoints.push(pendingEntry!.point)
            mergedAt.push(pendingEntry!.at)
            right += 1
          }
        }
        orderedCache = orderedCache.slice(0, suffixStart).concat(mergedPoints)
        cacheAtMs = cacheAtMs.slice(0, suffixStart).concat(mergedAt)
      }
      pendingAppends = []
    }
    if (pendingEvictions.length > 0) {
      // Evicted points leave the listing in tandem with their timestamps.
      // Appends can, in a pathological window configuration, be evicted by
      // their own record call before any read folded them, so the dead-set
      // applies to the folded result as a whole.
      const dead = new Set(pendingEvictions)
      const nextPoints: ResourceMetric[] = []
      const nextAtMs: number[] = []
      for (let index = 0; index < orderedCache.length; index += 1) {
        const point = orderedCache[index]!
        if (!dead.has(point)) {
          nextPoints.push(point)
          nextAtMs.push(cacheAtMs[index]!)
        }
      }
      orderedCache = nextPoints
      cacheAtMs = nextAtMs
      pendingEvictions = []
    }
    needsFullRebuild = false
    return orderedCache
  }

  return {
    recordSample(owner, sample) {
      const at = now()
      let history = owners.get(owner.ownerId)
      if (!history) {
        history = { points: [], atMs: [], lastSample: undefined }
        owners.set(owner.ownerId, history)
        ownerSeq.set(owner.ownerId, nextOwnerSeq)
        nextOwnerSeq += 1
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
      history.atMs.push(at)
      // In-place two-axis prune — the 24-hour window, then the per-owner cap —
      // with the exact legacy predicate (`observedAt` inside the horizon),
      // compacting both parallel arrays and reporting every evicted point so
      // the maintained listing can drop them too.
      const horizon = at - windowMs
      let write = 0
      for (let read = 0; read < history.points.length; read += 1) {
        const pointAtMs = history.atMs[read]!
        if (pointAtMs >= horizon) {
          history.points[write] = history.points[read]!
          history.atMs[write] = pointAtMs
          write += 1
        } else {
          pendingEvictions.push(history.points[read]!)
        }
      }
      history.points.length = write
      history.atMs.length = write
      const overflow = history.points.length - maxPoints
      if (overflow > 0) {
        for (let index = 0; index < overflow; index += 1) {
          pendingEvictions.push(history.points[index]!)
        }
        history.points.splice(0, overflow)
        history.atMs.splice(0, overflow)
      }
      // The new point is the newest of its owner: it survives both prunes
      // above, so the listing delta is an append.
      noteAppend({ point, at, ownerSeq: ownerSeq.get(owner.ownerId)! })
    },

    list(filter = {}) {
      if (
        filter.runtimeSessionId === undefined &&
        filter.worktreeId === undefined &&
        filter.processRecordId === undefined &&
        filter.fromMs === undefined &&
        filter.toMs === undefined
      ) {
        return orderedListing()
      }
      // Filtered reads scan the per-owner histories directly (numeric
      // timestamps, no ISO re-parsing) and stable-sort the matches with the
      // same comparator as the full listing.
      const matches: ResourceMetric[] = []
      for (const history of owners.values()) {
        for (let index = 0; index < history.points.length; index += 1) {
          const point = history.points[index]!
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
          const at = history.atMs[index]!
          if (filter.fromMs !== undefined && at < filter.fromMs) continue
          if (filter.toMs !== undefined && at > filter.toMs) continue
          matches.push(point)
        }
      }
      return matches.toSorted((left, right) => left.observedAt.localeCompare(right.observedAt))
    },
  }
}
