// Usage adapter contract for #424 (issue slice: provider subscription/usage
// adapters with typed source, freshness, and failure).
//
// Design evidence only (no donor code available or transcribed): t3code's
// `apps/server/src/usage/**` separates per-provider usage sources from
// presentation, and Orca's `src/main/automations/run-usage-collection.ts`
// demonstrates local collection scheduling; both are cited in
// docs/research/dev-view-source-manifest.json (#424 slice). The Adea contract
// below follows docs/specs/dev-runtime.md "Process, port, metrics, and
// usage": every adapter labels its source as `official_api |
// harness_protocol | local_transcript_estimate`, carries a safe display
// account label, a period, used/remaining quantities with unit, confidence,
// captured/expires freshness, and a typed failure. Estimates are never
// billing truth, and adapter failures can never block terminal/harness use.
import type {
  DevErrorCode,
  UsageRecord,
  UsageSource,
} from '../../../../../../packages/types/src/dev-runtime'

/** A record an adapter observed; ids and timestamps are minted by the
 * service so adapters stay pure functions of their provider payload. */
export type UsageObservation = Readonly<{
  ownerId: string
  provider: string
  quantity: string
  unit: string
  costMicros?: string
  confidence: 'authoritative' | 'measured' | 'estimated'
  accountLabel?: string
  period?: Readonly<{ from: string; to: string }>
  remaining?: string
  expiresInSeconds?: number
}>

export type UsageAdapterSuccess = Readonly<{ ok: true; observations: readonly UsageObservation[] }>

/** Typed failure: the adapter reports why it could not observe usage; the
 * service turns this into an explicit failure row, never a fabricated 0. */
export type UsageAdapterFailure = Readonly<{
  ok: false
  code: DevErrorCode
  message: string
  /** Honored (and jittered) before the next attempt when present. */
  retryAfterSeconds?: number
}>

export type UsageAdapterResult = UsageAdapterSuccess | UsageAdapterFailure

export type UsageAdapterContext = Readonly<{
  now: () => number
}>

export type UsageAdapter = Readonly<{
  /** Provider key the records and cache buckets are keyed by. */
  provider: string
  source: UsageSource
  /** One poll. Transport, credentials, and endpoint policy live inside the
   * adapter; the service only sequences and caches results. */
  fetchUsage(context: UsageAdapterContext): Promise<UsageAdapterResult>
}>

/** Turn one observation into the wire DTO. `capturedAt` is now;
 * `expiresAt` is now + expiresInSeconds (absent stays absent: no invented
 * freshness). */
export function usageRecordFromObservation(
  observation: UsageObservation,
  meta: Readonly<{ id: string; capturedAtMs: number; source: UsageSource }>
): UsageRecord {
  return {
    id: meta.id,
    ownerId: observation.ownerId,
    provider: observation.provider,
    quantity: observation.quantity,
    unit: observation.unit,
    ...(observation.costMicros !== undefined ? { costMicros: observation.costMicros } : {}),
    source: meta.source,
    confidence: observation.confidence,
    ...(observation.accountLabel !== undefined ? { accountLabel: observation.accountLabel } : {}),
    ...(observation.period !== undefined ? { period: observation.period } : {}),
    ...(observation.remaining !== undefined ? { remaining: observation.remaining } : {}),
    capturedAt: new Date(meta.capturedAtMs).toISOString(),
    ...(observation.expiresInSeconds !== undefined
      ? {
          expiresAt: new Date(
            meta.capturedAtMs + observation.expiresInSeconds * 1000
          ).toISOString(),
        }
      : {}),
    observedAt: new Date(meta.capturedAtMs).toISOString(),
  }
}

/** The explicit failure row for an adapter that could not observe usage:
 * quantities are the string `unknown` — the UI renders them as unknown and
 * never as 0. */
export function usageFailureRecord(
  provider: string,
  failure: Readonly<{ code: DevErrorCode; message: string }>,
  meta: Readonly<{ id: string; capturedAtMs: number; ownerId: string; source: UsageSource }>
): UsageRecord {
  return {
    id: meta.id,
    ownerId: meta.ownerId,
    provider,
    quantity: 'unknown',
    unit: 'unknown',
    source: meta.source,
    confidence: 'estimated',
    capturedAt: new Date(meta.capturedAtMs).toISOString(),
    failure: { code: failure.code, message: failure.message },
    observedAt: new Date(meta.capturedAtMs).toISOString(),
  }
}
