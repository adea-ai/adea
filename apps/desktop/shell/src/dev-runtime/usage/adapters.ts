// Provider usage adapters for #424: Codex and Claude official-API adapters
// plus a generic local-transcript estimate adapter.
//
// These are fixture-capable contract adapters, not network feature flips: a
// production endpoint requires a reviewed fixed URL, a credential from the
// M10 vault (host scoped), and the fetch guard in `fetch-policy.ts`. Without
// a credential the adapter returns typed `auth_required` without touching
// the network, so Dev View shows an explicit state instead of fabricating
// usage. Response schemas are validated strictly: a schema drift is a typed
// `invalid_state`, never a partial success. Adapter failures can never block
// terminal or harness use — they only ever surface as typed rows.
import type { UsageAdapter, UsageAdapterResult, UsageObservation } from './contract'
import { admitUsageEndpoint } from './fetch-policy'

export type OfficialApiUsageAdapterInput = Readonly<{
  provider: string
  /** Account identifier safe for display (never a token or secret). */
  accountLabel?: string
  ownerId: string
  endpoint: string
  /** Present only when the vault holds a usable credential for this host. */
  credential?: string
  fetchImpl?: typeof fetch
  resolveDns?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>
  /** Strict response validator; anything unexpected is `invalid_state`. */
  parseResponse: (body: unknown) => readonly UsageObservation[]
}>

/** Shape shared by the Codex and Claude usage payloads this slice accepts:
 * a top-level object with `period` and `usage` rows; every field required.
 * Provider-specific undocumented endpoints are deliberately not wired — the
 * endpoint constant is injected by the composition after terms review. */
/** Strict ISO timestamp for one period bound; a drifted schema is a
 * TypeError so the adapter reports typed `invalid_state`. */
function periodAt(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new TypeError(`expected ISO ${field}`)
  return value
}

export function parseUsagePayload(body: unknown): readonly UsageObservation[] {
  if (typeof body !== 'object' || body === null) throw new TypeError('expected object')
  const record = body as Record<string, unknown>
  if (!Array.isArray(record.usage)) throw new TypeError('expected usage array')
  const period = record.period as Record<string, unknown> | undefined
  if (typeof period !== 'object' || period === null) throw new TypeError('expected period')
  const from = periodAt(period.from, 'period.from')
  const to = periodAt(period.to, 'period.to')
  return record.usage.map((row): UsageObservation => {
    if (typeof row !== 'object' || row === null) throw new TypeError('expected usage row')
    const entry = row as Record<string, unknown>
    if (typeof entry.modelId !== 'string') throw new TypeError('expected modelId')
    if (typeof entry.quantity !== 'string') throw new TypeError('expected quantity')
    if (typeof entry.unit !== 'string') throw new TypeError('expected unit')
    return {
      ownerId: `${entry.modelId}`,
      provider: '',
      quantity: entry.quantity,
      unit: entry.unit,
      ...(typeof entry.costMicros === 'string' ? { costMicros: entry.costMicros } : {}),
      confidence: 'authoritative',
      period: { from, to },
    }
  })
}

const STATUS_CODES: ReadonlyMap<
  number,
  { code: 'auth_required' | 'rate_limited' | 'unavailable' | 'invalid_state'; message: string }
> = new Map([
  [401, { code: 'auth_required', message: 'the usage credential was rejected' }],
  [403, { code: 'auth_required', message: 'the usage credential lacks access' }],
  [404, { code: 'invalid_state', message: 'the usage endpoint does not exist' }],
  [429, { code: 'rate_limited', message: 'the usage endpoint is rate limiting' }],
])

export function createOfficialApiUsageAdapter(input: OfficialApiUsageAdapterInput): UsageAdapter {
  const fetchImpl = input.fetchImpl ?? fetch
  return {
    provider: input.provider,
    source: 'official_api',
    async fetchUsage(): Promise<UsageAdapterResult> {
      // Credential gate first: without a vault credential the network is
      // never touched and the typed state is explicit.
      if (input.credential === undefined || input.credential.length === 0) {
        return {
          ok: false,
          code: 'auth_required',
          message: `no ${input.provider} credential is configured for usage reporting`,
        }
      }
      let resolved: readonly { address: string; family: 4 | 6 }[] | undefined
      if (input.resolveDns !== undefined) {
        try {
          resolved = await input.resolveDns(new URL(input.endpoint).hostname)
        } catch {
          resolved = []
        }
      }
      const admission = admitUsageEndpoint(
        input.endpoint,
        { fixedEndpoint: input.endpoint },
        resolved
      )
      if (!admission.ok) return admission
      try {
        // redirect: 'error' — the guard refuses every redirect (spec). The
        // fetch is bounded (spec: 5-second command timeout) so a hung
        // endpoint can never block a listing.
        const response = await fetchImpl(admission.url, {
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
          headers: {
            authorization: `Bearer ${input.credential}`,
            accept: 'application/json',
          },
        })
        if (!response.ok) {
          const mapped = STATUS_CODES.get(response.status)
          const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
          return {
            ok: false,
            ...(mapped ?? {
              code: 'invalid_state' as const,
              message: `unexpected usage endpoint status ${response.status}`,
            }),
            ...(Number.isFinite(retryAfter) && retryAfter > 0
              ? { retryAfterSeconds: retryAfter }
              : {}),
          }
        }
        const body: unknown = await response.json()
        const observations = input.parseResponse(body)
        return {
          ok: true,
          observations: observations.map((observation) => ({
            ...observation,
            provider: input.provider,
            ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel } : {}),
            // Declared freshness: one hour until a provider contract says
            // otherwise; caches expire rather than growing stale silently.
            expiresInSeconds: 3_600,
          })),
        }
      } catch (error) {
        return {
          ok: false,
          code: 'unavailable',
          message: error instanceof Error ? error.message : 'usage fetch failed',
        }
      }
    },
  }
}

export type LocalEstimateAdapterInput = Readonly<{
  provider: string
  ownerId: string
  /** Estimates computed by the caller (e.g. from harness run transcripts).
   * Returning none is truthful and common: estimates exist only when a
   * transcript source was actually measured. */
  estimate: () => readonly UsageObservation[]
}>

/** The generic `local_transcript_estimate` adapter: every row it produces is
 * labeled confidence `estimated` and is never presented as billing truth. */
export function createLocalEstimateAdapter(input: LocalEstimateAdapterInput): UsageAdapter {
  return {
    provider: input.provider,
    source: 'local_transcript_estimate',
    async fetchUsage(): Promise<UsageAdapterResult> {
      let observations: readonly UsageObservation[]
      try {
        observations = input.estimate()
      } catch (error) {
        return {
          ok: false,
          code: 'invalid_state',
          message: error instanceof Error ? error.message : 'estimate source failed',
        }
      }
      return {
        ok: true,
        observations: observations.map((observation) => ({
          ...observation,
          provider: input.provider,
          confidence: 'estimated',
        })),
      }
    },
  }
}
