/*
 * Cookie import (#646) client model: the sources a client may read, and the
 * preview it shows before committing a plan. A source carries no store path and
 * no cookie value — a client addresses it by id — and the preview is projected
 * from the plan's value-free `factVersions`, so neither half can leak a secret
 * into the surface.
 */
import type { MutationPlan } from '@adea-ai/types/dev-runtime'

/** Mirrors the wire `CookieSource` decoder: id, kind, label, availability. */
export type CookieSource = Readonly<{
  id: string
  kind: 'chrome' | 'chromium' | 'brave' | 'edge' | 'firefox' | 'safari'
  label: string
  availability: 'available' | 'locked' | 'unsupported_format' | 'unreadable'
  detail?: string
}>

export type CookieImportPreview = Readonly<{
  planId: string
  planDigest: string
  expiresAt: string
  /** The registrable families the plan would import, sorted for display. */
  domains: readonly string[]
  /** Cookies the plan would write into the lane profile. */
  stagedWrites: number
  /** Cookies already present that the plan would replace. */
  stagedRemovals: number
  /** Source cookies the plan deliberately leaves alone. */
  skipped: number
  blockers: readonly string[]
}>

const browserLabels: Record<CookieSource['kind'], string> = {
  chrome: 'Google Chrome',
  chromium: 'Chromium',
  brave: 'Brave',
  edge: 'Microsoft Edge',
  firefox: 'Firefox',
  safari: 'Safari',
}

export function cookieSourceLabel(source: CookieSource): string {
  return source.label.trim().length > 0 ? source.label : browserLabels[source.kind]
}

/**
 * A source that cannot be read is still a row: the surface states why instead
 * of hiding a browser the user knows is installed.
 */
export function cookieSourceState(source: CookieSource): Readonly<{
  selectable: boolean
  note: string
}> {
  switch (source.availability) {
    case 'available':
      return { selectable: true, note: '' }
    case 'locked':
      return {
        selectable: false,
        note: 'Locked by the browser. Quit it and reload the sources to import.',
      }
    case 'unsupported_format':
      return {
        selectable: false,
        note: 'This profile stores cookies in a format this runtime cannot read.',
      }
    case 'unreadable':
      return { selectable: false, note: 'The profile exists but could not be read.' }
  }
}

function countOf(value: string | undefined): number {
  const parsed = Number(value ?? '0')
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

/** Projects the value-free plan facts into the preview the surface renders. */
export function previewFromPlan(plan: MutationPlan): CookieImportPreview {
  const facts = plan.factVersions
  return {
    planId: plan.id,
    planDigest: plan.digest,
    expiresAt: plan.expiresAt,
    domains: (facts.domains ?? '')
      .split(',')
      .map((domain) => domain.trim())
      .filter((domain) => domain.length > 0),
    stagedWrites: countOf(facts.stagedWrites),
    stagedRemovals: countOf(facts.stagedRemovals),
    skipped: countOf(facts.skipped),
    blockers: plan.blockers.map((blocker) => blocker.message),
  }
}

export function previewSummary(preview: CookieImportPreview): string {
  if (preview.stagedWrites === 0 && preview.stagedRemovals === 0)
    return `Nothing to import from ${preview.domains.length} selected ${
      preview.domains.length === 1 ? 'family' : 'families'
    }.`
  const parts = [
    `${preview.stagedWrites} ${preview.stagedWrites === 1 ? 'cookie' : 'cookies'} to import`,
  ]
  if (preview.stagedRemovals > 0)
    parts.push(
      `${preview.stagedRemovals} ${preview.stagedRemovals === 1 ? 'cookie' : 'cookies'} replaced`
    )
  if (preview.skipped > 0) parts.push(`${preview.skipped} skipped`)
  return `${parts.join(' · ')} across ${preview.domains.length} ${
    preview.domains.length === 1 ? 'family' : 'families'
  }.`
}

/**
 * A plan expires and can carry blockers; both refuse the commit rather than
 * letting a stale digest look like a successful import.
 */
export function canCommit(preview: CookieImportPreview, now: string): boolean {
  if (preview.blockers.length > 0) return false
  if (preview.stagedWrites === 0 && preview.stagedRemovals === 0) return false
  const expiresAt = Date.parse(preview.expiresAt)
  const nowMs = Date.parse(now)
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs)) return false
  return expiresAt > nowMs
}

export function importOutcomeMessage(result: {
  imported: number
  skipped: number
  rolledBack: boolean
}): string {
  if (result.rolledBack)
    return 'The import failed and was rolled back; the lane profile is unchanged.'
  const imported = `${result.imported} ${result.imported === 1 ? 'cookie' : 'cookies'} imported`
  return result.skipped > 0 ? `${imported} · ${result.skipped} skipped.` : `${imported}.`
}
