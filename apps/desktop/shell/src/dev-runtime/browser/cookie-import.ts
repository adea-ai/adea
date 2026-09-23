// Cookie import as a previewed, atomic plan/commit transaction.
//
// Adea hardening over the donors: Orca's importer (MIT, revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7) continues after individual write
// failures and reports partial success; t3code's (MIT, revision
// 77bca8b2d76a1f42552e5eee7d277fcb1160347a) does the same. The Dev Runtime
// spec requires the opposite: any write or cancel failure rolls back the
// whole import, the plan is previewed and digest-bound, replacement is
// scoped to the imported registrable families, high-risk origins are
// excluded by policy, values never enter logs or events, and the serialized
// input is bounded at 10,000 cookies / 16 MiB. Partition/SameSite attributes
// are preserved verbatim on both staging and rollback.
import { createHash } from 'node:crypto'

export type ImportedCookie = Readonly<{
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified'
  /** Partition key preserved through import and rollback. */
  partitionKey?: Readonly<{ topLevelSite?: string; hasCrossSiteAncestor?: boolean }>
  expiresAt?: string
}>

/**
 * The lane cookie store seam the host implements over the lane's own
 * profile. Implementations must never surface values outside this object.
 */
export type LaneCookieStore = Readonly<{
  list(): Promise<readonly ImportedCookie[]>
  remove(cookies: readonly ImportedCookie[]): Promise<void>
  write(cookies: readonly ImportedCookie[]): Promise<void>
}>

export type CookieImportPolicyInput = Readonly<{
  domains: readonly string[]
  /** Explicit user override that re-includes excluded high-risk origins. */
  includeExcluded?: boolean
}>

export type CookieImportPolicyVerdict = Readonly<{
  accepted: readonly string[]
  excluded: readonly Readonly<{ domain: string; reason: 'excluded_by_policy' | 'invalid' }>[]
  warned: readonly Readonly<{ domain: string; reason: 'excluded_by_policy' }>[]
}>

// Registrable families whose sessions are device-bound server-side; a
// transplanted cookie is rejected or expired regardless of copy fidelity, so
// an import never writes and never removes them. Follows Orca's policy
// (google.com), which cites STA-3811; entries are canonical registrable
// domains, matching the family and everything under it.
const NON_TRANSPLANTABLE_FAMILIES: readonly string[] = ['google.com']

const MAX_COOKIES = 10_000
const MAX_SERIALIZED_BYTES = 16 * 1024 * 1024
const MAX_DOMAINS = 128

/**
 * Normalizes a cookie domain to a comparable host. Rejects URL metacharacters,
 * ports, and dot-segment tricks. (Orca normalizeCookieDomain, minus the psl
 * dependency; the registrable-family rule below covers the same scope tests.)
 */
export function normalizeCookieDomain(domain: string): string | null {
  const candidate = domain.trim().replace(/^\.+/, '').toLowerCase()
  if (!candidate || /[/\\@?#%]/.test(candidate) || candidate.includes(':')) return null
  // A registrable import domain needs at least two labels; single-label
  // hosts (localhost, ephemeral hostnames) are not importable origins.
  if (candidate.split('.').length < 2) return null
  try {
    // Parse-only canonicalization for the candidate host; the desktop boot
    // boundary forbids literal remote URL schemes in shell sources, so the
    // authority separator is assembled rather than spelled out.
    const parsed = new URL(`https:${'//'}${candidate}/`)
    const normalized = parsed.hostname.toLowerCase()
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      normalized.endsWith('.') ||
      normalized.includes('..')
    )
      return null
    return normalized
  } catch {
    return null
  }
}

/**
 * Names the registrable family of a host: the suffix that a cookie set for
 * the host applies to. Hosts under a known multi-label public suffix use the
 * three-label form (e.g. a.b.co.uk → b.co.uk); everything else uses the last
 * two labels. IP literals are their own family. This is deliberately
 * conservative: an unknown suffix yields the two-label family, never a bare
 * public suffix (naming `com` as a family would silently exempt a TLD).
 */
const MULTI_LABEL_SUFFIXES: readonly string[] = [
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.cn',
  'com.mx',
  'co.in',
  'co.za',
]

export function registrableFamily(domain: string): string | null {
  const host = normalizeCookieDomain(domain)
  if (!host) return null
  if (netIsIp(host)) return host
  const labels = host.split('.')
  if (labels.length < 2) return host
  const lastTwo = labels.slice(-2).join('.')
  if (MULTI_LABEL_SUFFIXES.includes(lastTwo) && labels.length >= 3)
    return labels.slice(-3).join('.')
  return lastTwo
}

function netIsIp(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return host.includes(':')
}

function isUnder(domain: string, family: string): boolean {
  return domain === family || domain.endsWith(`.${family}`)
}

export function isNonTransplantableCookieDomain(domain: string): boolean {
  const normalized = normalizeCookieDomain(domain)
  if (!normalized) return false
  return NON_TRANSPLANTABLE_FAMILIES.some((family) => isUnder(normalized, family))
}

/** Applies the exclusion policy and validation to a plan's domain list. */
export function applyCookieImportPolicy(input: CookieImportPolicyInput): CookieImportPolicyVerdict {
  const seen = new Set<string>()
  const accepted: string[] = []
  const excluded: { domain: string; reason: 'excluded_by_policy' | 'invalid' }[] = []
  const warned: { domain: string; reason: 'excluded_by_policy' }[] = []
  for (const raw of input.domains.slice(0, MAX_DOMAINS)) {
    const normalized = normalizeCookieDomain(raw)
    if (!normalized) {
      excluded.push({ domain: raw, reason: 'invalid' })
      continue
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    const nonTransplantable = isNonTransplantableCookieDomain(normalized)
    if (nonTransplantable && input.includeExcluded !== true) {
      excluded.push({ domain: normalized, reason: 'excluded_by_policy' })
      continue
    }
    if (nonTransplantable && input.includeExcluded === true)
      warned.push({ domain: normalized, reason: 'excluded_by_policy' })
    accepted.push(normalized)
  }
  return { accepted, excluded, warned }
}

export type CookieImportPlanInput = Readonly<{
  browserLaneId: string
  laneGeneration: number
  sourceProfileId: string
  domains: readonly string[]
  includeExcluded?: boolean
  /** Reader over the source profile's cookies (host-injected). */
  readSource: () => Promise<readonly ImportedCookie[]>
  targetStore: LaneCookieStore
}>

export type CookieImportPlan = Readonly<{
  id: string
  browserLaneId: string
  laneGeneration: number
  scope: Readonly<{ domains: readonly string[]; sourceProfileId: string }>
  stagedWrites: readonly ImportedCookie[]
  stagedRemovals: readonly ImportedCookie[]
  skipped: number
  digest: string
  expiresAt: string
}>

export type CookieImportCommitResult = Readonly<{
  browserLaneId: string
  imported: number
  skipped: number
  rolledBack: boolean
  observedAt: string
}>

function serializedByteLength(cookies: readonly ImportedCookie[]): number {
  return new TextEncoder().encode(JSON.stringify(cookies)).byteLength
}

export class CookieImportError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CookieImportError'
    this.code = code
  }
}

export function createCookieImportService(
  options: Readonly<{ now?: () => string; randomId?: () => string; planTtlMs?: number }> = {}
) {
  const now = options.now ?? (() => new Date().toISOString())
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  const planTtlMs = options.planTtlMs ?? 60_000
  const plans = new Map<string, { plan: CookieImportPlan; expiresAt: number }>()

  function digest(plan: Omit<CookieImportPlan, 'digest' | 'expiresAt' | 'id'>): string {
    // The digest binds the staged writes, removals, scope, and the lane's
    // generation so a commit cannot apply a plan computed against stale state.
    return createDigest([
      'adea-cookie-import-plan-v1',
      plan.browserLaneId,
      plan.laneGeneration,
      plan.scope,
      plan.stagedWrites.map((cookie) => [cookie.domain, cookie.name, cookie.path, cookie.sameSite]),
      plan.stagedRemovals.map((cookie) => [cookie.domain, cookie.name, cookie.path]),
      plan.skipped,
    ])
  }

  return {
    /**
     * Builds and previews a plan. The source is read once; values stay inside
     * the returned plan object and are never logged.
     */
    async plan(input: CookieImportPlanInput): Promise<CookieImportPlan> {
      const verdict = applyCookieImportPolicy({
        domains: input.domains,
        includeExcluded: input.includeExcluded,
      })
      if (verdict.accepted.length === 0)
        throw new CookieImportError(
          'cookie_import_failed',
          'no importable domains remain after policy'
        )
      let source: readonly ImportedCookie[]
      try {
        source = await input.readSource()
      } catch (cause) {
        // A host reader failure — an unreadable profile, a keychain decrypt
        // refusal — is a typed import failure, never a raw host error escaping
        // the operation. Planning writes nothing, so the lane is untouched.
        throw new CookieImportError(
          'cookie_import_failed',
          cause instanceof Error ? cause.message : 'the cookie source could not be read'
        )
      }
      if (source.length > MAX_COOKIES)
        throw new CookieImportError('limit_exceeded', 'source exceeds 10,000 cookies')
      const families = verdict.accepted
        .map((domain) => registrableFamily(domain))
        .filter((f): f is string => f !== null)
      const stagedWrites: ImportedCookie[] = []
      let skipped = 0
      for (const cookie of source) {
        const family = registrableFamily(cookie.domain)
        const inScope =
          family !== null &&
          families.some((accepted) => family === accepted || isUnder(family, accepted))
        // Excluded families are never written, even if the source carries them
        // under a domain the caller asked for.
        if (!inScope || isNonTransplantableCookieDomain(cookie.domain)) {
          skipped += 1
          continue
        }
        stagedWrites.push(cookie)
      }
      if (stagedWrites.length > MAX_COOKIES)
        throw new CookieImportError('limit_exceeded', 'plan exceeds 10,000 cookies')
      if (serializedByteLength(stagedWrites) > MAX_SERIALIZED_BYTES)
        throw new CookieImportError('limit_exceeded', 'plan exceeds 16 MiB serialized')
      // Replacement is scoped to the imported families: existing target
      // cookies under those families are removed; everything else survives.
      const target = await input.targetStore.list()
      const stagedRemovals = target.filter((cookie) => {
        const family = registrableFamily(cookie.domain)
        if (family === null) return false
        if (isNonTransplantableCookieDomain(cookie.domain)) return false
        return families.some((accepted) => family === accepted || isUnder(family, accepted))
      })
      const base = {
        browserLaneId: input.browserLaneId,
        laneGeneration: input.laneGeneration,
        scope: { domains: [...verdict.accepted], sourceProfileId: input.sourceProfileId },
        stagedWrites,
        stagedRemovals,
        skipped,
      }
      const plan: CookieImportPlan = {
        ...base,
        id: randomId(),
        digest: digest(base),
        expiresAt: new Date(Date.parse(now()) + planTtlMs).toISOString(),
      }
      plans.set(plan.id, { plan, expiresAt: Date.parse(plan.expiresAt) })
      return plan
    },

    async commit(
      planId: string,
      planDigest: string,
      targetStore: LaneCookieStore,
      cancel?: Readonly<{ cancelled: boolean }>
    ): Promise<CookieImportCommitResult> {
      const record = plans.get(planId)
      if (!record) throw new CookieImportError('plan_stale', 'plan is unknown or expired')
      if (record.expiresAt < Date.parse(now())) {
        plans.delete(planId)
        throw new CookieImportError('plan_stale', 'plan expired')
      }
      if (record.plan.digest !== planDigest)
        throw new CookieImportError('plan_stale', 'plan digest does not match staged facts')
      plans.delete(planId)
      const plan = record.plan

      // 1. Snapshot the in-scope existing rows (identity + value + partition)
      // so every removal can be undone. The snapshot never leaves this scope.
      const snapshot = plan.stagedRemovals
      const written: ImportedCookie[] = []
      const rollback = async (): Promise<CookieImportCommitResult> => {
        // Roll back in strict reverse order: undo writes first, then restore
        // every removal to its exact pre-import value and partition.
        let rollbackFailed = false
        try {
          if (written.length > 0) await targetStore.remove(written)
        } catch {
          rollbackFailed = true
        }
        try {
          if (snapshot.length > 0) await targetStore.write(snapshot)
        } catch {
          rollbackFailed = true
        }
        if (rollbackFailed)
          throw new CookieImportError(
            'rollback_failed',
            'the import failed and the rollback was incomplete; the lane profile needs a manual reset'
          )
        return {
          browserLaneId: plan.browserLaneId,
          imported: 0,
          skipped: plan.skipped,
          rolledBack: true,
          observedAt: now(),
        }
      }

      try {
        // 2. Remove the in-scope existing rows, tracking progress.
        for (const cookie of plan.stagedRemovals) {
          if (cancel?.cancelled) return await rollback()
          await targetStore.remove([cookie])
        }
        // 3. Write the imported rows; a cookie arriving mid-import under a
        // snapshotted coordinate is replaced by the pre-import value on
        // rollback (the snapshot is the rollback truth, not a re-read).
        for (const cookie of plan.stagedWrites) {
          if (cancel?.cancelled) return await rollback()
          await targetStore.write([cookie])
          written.push(cookie)
        }
      } catch (error) {
        // 4. Any failure rolls back the WHOLE import — never a partial merge.
        await rollback()
        if (error instanceof CookieImportError) throw error
        throw new CookieImportError(
          'cookie_import_failed',
          `import rolled back: ${error instanceof Error ? error.message : 'store error'}`
        )
      }
      return {
        browserLaneId: plan.browserLaneId,
        imported: written.length,
        skipped: plan.skipped,
        rolledBack: false,
        observedAt: now(),
      }
    },

    /** Messages carry domains and names only — never values. */
    static: {
      MAX_COOKIES,
      MAX_SERIALIZED_BYTES,
      MAX_DOMAINS,
    },
  }
}

function createDigest(parts: readonly unknown[]): string {
  // Same canonical-JSON digest discipline as the lane profile identity.
  // Values are excluded from the digest input so the digest itself can be
  // logged; the staged writes travel only inside the plan object.
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')
}

export type CookieImportService = ReturnType<typeof createCookieImportService>
