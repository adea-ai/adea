// Usage service for #424: sequences the per-provider adapters into a bounded,
// fresh cache the `dev.resources.usage` provider serves.
//
// Provider limits are honored with exponential backoff plus jitter; a manual
// refresh inside the 60-second floor is served from cache (spec: "manual
// refresh has a 60-second floor unless an official contract permits less").
// Records are kept per provider with a bounded history; a failed poll stores
// an explicit typed-failure row (never a fabricated 0) and never blocks the
// listing. The clock and RNG are injected so backoff and floors are
// deterministic under test.
import { randomUUID } from 'node:crypto'

import type { UsageRecord } from '../../../../../../packages/types/src/dev-runtime'
import { usageFailureRecord, usageRecordFromObservation, type UsageAdapter } from './contract'

export const MANUAL_REFRESH_FLOOR_MS = 60_000
const BASE_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 10 * 60_000
/** Bounded history: the newest records per provider the cache retains. */
const MAX_RECORDS_PER_PROVIDER = 120

type ProviderCache = {
  records: UsageRecord[]
  lastFetchAt: number
  lastManualRefreshAt: number
  backoffUntil: number
  backoffAttempt: number
  inFlight: Promise<void> | undefined
}

export type UsageService = Readonly<{
  /** Cached records for one provider, or all providers when omitted. */
  list(provider?: string): UsageRecord[]
  /** True when every matching bucket is fresh against its expiry/backoff. */
  fresh(provider?: string): boolean
  /** Background refresh of stale/expired buckets; resolves when idle. */
  refreshStale(): Promise<void>
  /** Manual refresh: immediate for buckets past the 60-second floor. */
  manualRefresh(provider?: string): Promise<void>
}>

export type UsageServiceInput = Readonly<{
  adapters: readonly UsageAdapter[]
  now?: () => number
  randomId?: () => string
  /** Jitter source for backoff (0..1); defaults to Math.random. */
  jitter?: () => number
}>

export function createUsageService(input: UsageServiceInput): UsageService {
  const now = input.now ?? Date.now
  const randomId = input.randomId ?? randomUUID
  const jitter = input.jitter ?? Math.random
  const buckets = new Map<string, ProviderCache>()

  const bucketFor = (provider: string): ProviderCache => {
    let bucket = buckets.get(provider)
    if (!bucket) {
      bucket = {
        records: [],
        lastFetchAt: 0,
        lastManualRefreshAt: 0,
        backoffUntil: 0,
        backoffAttempt: 0,
        inFlight: undefined,
      }
      buckets.set(provider, bucket)
    }
    return bucket
  }

  function applyResult(
    adapter: UsageAdapter,
    bucket: ProviderCache,
    result: Awaited<ReturnType<UsageAdapter['fetchUsage']>>
  ): void {
    const at = now()
    bucket.lastFetchAt = at
    if (result.ok) {
      bucket.records = result.observations
        .map((observation) =>
          usageRecordFromObservation(observation, {
            id: randomId(),
            capturedAtMs: at,
            source: adapter.source,
          })
        )
        .slice(-MAX_RECORDS_PER_PROVIDER)
      bucket.backoffUntil = 0
      bucket.backoffAttempt = 0
      return
    }
    const failure = usageFailureRecord(adapter.provider, result, {
      id: randomId(),
      capturedAtMs: at,
      ownerId: `usage:${adapter.provider}`,
      source: adapter.source,
    })
    bucket.records = [failure, ...bucket.records.filter((row) => row.failure === undefined)].slice(
      0,
      MAX_RECORDS_PER_PROVIDER
    )
    const retryAfterMs =
      result.retryAfterSeconds !== undefined ? result.retryAfterSeconds * 1000 : undefined
    const backoff = Math.min(
      BASE_BACKOFF_MS * 2 ** Math.min(bucket.backoffAttempt, 8),
      MAX_BACKOFF_MS
    )
    bucket.backoffAttempt += 1
    bucket.backoffUntil = at + Math.max(retryAfterMs ?? 0, backoff * (0.5 + 0.5 * jitter()))
  }

  function stale(bucket: ProviderCache): boolean {
    if (bucket.inFlight) return false
    if (bucket.records.length === 0 && bucket.lastFetchAt === 0) return true
    if (now() < bucket.backoffUntil) return false
    const newestExpiry = bucket.records
      .map((row) => row.expiresAt)
      .filter((value): value is string => value !== undefined)
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value))
      .toSorted((left, right) => right - left)[0]
    if (newestExpiry !== undefined) return now() >= newestExpiry
    // No declared freshness: treat a bucket older than the manual floor as
    // eligible for a background refresh.
    return now() - bucket.lastFetchAt >= MANUAL_REFRESH_FLOOR_MS
  }

  async function poll(adapter: UsageAdapter, bucket: ProviderCache): Promise<void> {
    if (bucket.inFlight) return bucket.inFlight
    const job = (async () => {
      try {
        const result = await adapter.fetchUsage({ now })
        applyResult(adapter, bucket, result)
      } catch (error) {
        applyResult(adapter, bucket, {
          ok: false,
          code: 'unavailable',
          message: error instanceof Error ? error.message : 'usage adapter failed',
        })
      } finally {
        bucket.inFlight = undefined
      }
    })()
    bucket.inFlight = job
    return job
  }

  return {
    list(provider) {
      const matches = input.adapters
        .filter((adapter) => provider === undefined || adapter.provider === provider)
        .map((adapter) => buckets.get(adapter.provider))
        .filter((bucket): bucket is ProviderCache => bucket !== undefined)
      return matches.flatMap((bucket) => bucket.records)
    },

    fresh(provider) {
      return input.adapters
        .filter((adapter) => provider === undefined || adapter.provider === provider)
        .every((adapter) => {
          const bucket = buckets.get(adapter.provider)
          return bucket !== undefined && !stale(bucket)
        })
    },

    async refreshStale() {
      const jobs: Promise<void>[] = []
      for (const adapter of input.adapters) {
        const bucket = bucketFor(adapter.provider)
        if (stale(bucket)) jobs.push(poll(adapter, bucket))
      }
      await Promise.all(jobs)
    },

    async manualRefresh(provider) {
      const targets = input.adapters.filter(
        (adapter) => provider === undefined || adapter.provider === provider
      )
      if (targets.length === 0) return
      const at = now()
      const jobs: Promise<void>[] = []
      for (const adapter of targets) {
        const bucket = bucketFor(adapter.provider)
        if (at - bucket.lastManualRefreshAt < MANUAL_REFRESH_FLOOR_MS) continue
        bucket.lastManualRefreshAt = at
        jobs.push(poll(adapter, bucket))
      }
      await Promise.all(jobs)
    },
  }
}
