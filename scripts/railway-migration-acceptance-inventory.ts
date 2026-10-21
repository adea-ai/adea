/**
 * The Railway migration acceptance inventory (issue #1564).
 *
 * #1564 is the PARENT coordination issue: its implementation stays with the
 * reconciled child scopes - #1560 (source identity and adapter contract),
 * #1561 (separately gated provider/readback) and #1562 (freshness and
 * resource safeguards). This module does not duplicate them: it inventories
 * what is left, records the reviewed source heads and the applicable tests,
 * and names the acceptance that stays gated.
 *
 * Source/tests/documentation only: no credential, no paid resource, no
 * production read, no deployment, no cutover, no migration, no Neon deletion
 * and no permission change.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const REPOSITORY_ROOT = join(import.meta.dirname, '..')

/** The child scopes whose acceptance this parent coordinates. */
export const CHILD_SCOPES = [
  {
    issue: '#1560',
    subject: 'Railway source identity and adapter qualification',
    branch: 'recovery/issue-1560-w9-20261021',
  },
  {
    issue: '#1561',
    subject: 'separately gated provider and readback acceptance',
    branch: 'recovery/issue-1561-fresh-account-readback-plan',
  },
  {
    issue: '#1562',
    subject: 'freshness and resource safeguards',
    branch: 'recovery/issue-1562-cloudflare-cpu-hyperdrive-qualification',
  },
] as const

/** The related open pull requests, by their exact reviewed head. */
export const RELATED_PULL_REQUESTS = [
  {
    number: 1515,
    head: '312c49db2e77371cf38a5397c386439494e53019',
    subject: 'provider-coupling removal',
  },
  { number: 1525, head: 'f37411f4d', subject: 'auth transport-loss classification' },
] as const

/** The acceptance that stays gated until separate authorization exists. */
export const GATED_ACCEPTANCE = [
  {
    gate: 'fresh web and desktop login, PKCE, origin/CSRF, logout/revocation, reset and verification',
    state: 'gated',
  },
  { gate: 'live Railway target and readback', state: 'gated' },
  { gate: 'provider qualification', state: 'gated' },
  { gate: 'operational cutover and the one-week cost observation', state: 'gated' },
  {
    gate: 'production data copying, Neon deletion and permission changes',
    state: 'not authorized',
  },
] as const

/**
 * Markers that would mean a legacy import, a dual write or an old-data
 * reconciliation had been introduced. The migration must not carry any of
 * them.
 */
export const FORBIDDEN_MIGRATION_MARKERS = [
  'dualWrite',
  'dual_write',
  'legacyAccountImport',
  'legacy_account_import',
  'legacySessionImport',
  'reconcileOldAccounts',
  'oldDataReconciliation',
] as const

function walk(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = []
  const visit = (current: string) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
        continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(path)
    }
  }
  visit(join(REPOSITORY_ROOT, directory))
  return found
}

/** The source paths that still name the Neon provider or its authentication. */
export function inventoryNeonProviderDependencies(): string[] {
  const hits: string[] = []
  for (const file of walk('apps', ['.ts', '.tsx'])) {
    const source = readFileSync(file, 'utf8')
    if (/NEON_|neon\.|neonAuth|NeonAuth/i.test(source)) hits.push(relative(REPOSITORY_ROOT, file))
  }
  return hits.toSorted()
}

/** The forbidden legacy-import, dual-write and reconciliation markers found. */
export function scanForbiddenMigrationMarkers(): string[] {
  const hits: string[] = []
  for (const file of walk('apps', ['.ts', '.tsx'])) {
    // A test may legitimately name a forbidden marker to assert its absence;
    // the migration itself must not carry one.
    if (file.includes('.test.')) continue
    const source = readFileSync(file, 'utf8')
    for (const marker of FORBIDDEN_MIGRATION_MARKERS) {
      if (source.includes(marker)) hits.push(`${relative(REPOSITORY_ROOT, file)}: ${marker}`)
    }
  }
  return hits.toSorted()
}

/** The freshness qualification this parent depends on, by its exact path. */
export const FRESHNESS_QUALIFICATION = 'scripts/cloudflare-cpu-hyperdrive-qualification.ts'

/** Whether the freshness qualification this parent depends on is present. */
export function freshnessQualificationPresent(): boolean {
  try {
    statSync(join(REPOSITORY_ROOT, FRESHNESS_QUALIFICATION))
    return readFileSync(join(REPOSITORY_ROOT, FRESHNESS_QUALIFICATION), 'utf8').includes(
      'authority-reads-not-cache-disabled'
    )
  } catch {
    return false
  }
}

/** The inventory record, assembled from the repository's own sources. */
export function railwayMigrationAcceptanceInventory(): {
  neonProviderDependencies: string[]
  forbiddenMigrationMarkers: string[]
  freshnessQualificationPresent: boolean
  childScopes: typeof CHILD_SCOPES
  relatedPullRequests: typeof RELATED_PULL_REQUESTS
  gatedAcceptance: typeof GATED_ACCEPTANCE
} {
  return {
    neonProviderDependencies: inventoryNeonProviderDependencies(),
    forbiddenMigrationMarkers: scanForbiddenMigrationMarkers(),
    freshnessQualificationPresent: freshnessQualificationPresent(),
    childScopes: CHILD_SCOPES,
    relatedPullRequests: RELATED_PULL_REQUESTS,
    gatedAcceptance: GATED_ACCEPTANCE,
  }
}
