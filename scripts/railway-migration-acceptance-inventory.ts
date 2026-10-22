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
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

export const REPOSITORY_ROOT = join(import.meta.dirname, '..')

/**
 * The source roots the approved scope covers.
 *
 * The scan reads the whole tree of every root, so the coverage is explicit
 * rather than implied: the web and desktop application sources, and the
 * workspace packages, including the auth package whose configuration and
 * Neon driver still name the provider.
 */
export const SOURCE_SCAN_ROOTS = ['apps', 'packages'] as const

/** The source file extensions the scan reads. */
export const SOURCE_SCAN_EXTENSIONS = ['.ts', '.tsx'] as const

/** The directory names the scan never descends into. */
export const SOURCE_SCAN_SKIPPED_DIRECTORIES: readonly string[] = ['node_modules', 'dist']

/** A directory entry, as the scan sees it. */
export type SourceScanEntry = { name: string; isDirectory: boolean }

/** The file system the scan reads. It is injected so a regression can drive unreadable input. */
export type SourceScanReader = {
  readDirectory: (path: string) => SourceScanEntry[]
  readFile: (path: string) => string
}

/** How a scan is rooted and what it reads. */
export type SourceScanOptions = {
  root?: string
  reader?: SourceScanReader
  roots?: readonly string[]
  extensions?: readonly string[]
}

/** What a scan found, and what it could not read. */
export type SourceScan = { files: string[]; unreadable: string[] }

/** What a scanner reports: its hits, and every path it could not read. */
export type SourceScanResult = { hits: string[]; unreadable: string[] }

function defaultSourceReader(): SourceScanReader {
  return {
    readDirectory: (path) =>
      readdirSync(path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      })),
    readFile: (path) => readFileSync(path, 'utf8'),
  }
}

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

/**
 * The source files of the approved scope, and every path that could not be read.
 *
 * A root or subtree that cannot be read is **reported**, never treated as an
 * empty tree: an unreadable subtree would otherwise read as "nothing found
 * here", and a scan that could not see a file must not claim the file is
 * clean.
 */
export function scanSourceTree(options: SourceScanOptions = {}): SourceScan {
  const root = options.root ?? REPOSITORY_ROOT
  const reader = options.reader ?? defaultSourceReader()
  const roots = options.roots ?? SOURCE_SCAN_ROOTS
  const extensions = options.extensions ?? SOURCE_SCAN_EXTENSIONS
  const files: string[] = []
  const unreadable: string[] = []
  const visit = (current: string) => {
    let entries: SourceScanEntry[]
    try {
      entries = reader.readDirectory(current)
    } catch {
      unreadable.push(relative(root, current))
      return
    }
    for (const entry of entries) {
      if (SOURCE_SCAN_SKIPPED_DIRECTORIES.includes(entry.name) || entry.name.startsWith('.'))
        continue
      const path = join(current, entry.name)
      if (entry.isDirectory) visit(path)
      else if (extensions.some((extension) => entry.name.endsWith(extension))) files.push(path)
    }
  }
  for (const directory of roots) visit(join(root, directory))
  return { files: files.toSorted(), unreadable: unreadable.toSorted() }
}

function readScannedFile(
  file: string,
  reader: SourceScanReader,
  unreadable: string[]
): string | undefined {
  try {
    return reader.readFile(file)
  } catch {
    unreadable.push(file)
    return undefined
  }
}

/** The source paths that still name the Neon provider or its authentication. */
export function inventoryNeonProviderDependencies(
  options: SourceScanOptions = {}
): SourceScanResult {
  const root = options.root ?? REPOSITORY_ROOT
  const reader = options.reader ?? defaultSourceReader()
  const scan = scanSourceTree({ ...options, reader })
  const unreadable = [...scan.unreadable]
  const hits: string[] = []
  for (const file of scan.files) {
    const source = readScannedFile(file, reader, unreadable)
    if (source === undefined) continue
    if (/NEON_|neon\.|neonAuth|NeonAuth/i.test(source)) hits.push(relative(root, file))
  }
  return { hits: hits.toSorted(), unreadable: unreadable.toSorted() }
}

/** The forbidden legacy-import, dual-write and reconciliation markers found. */
export function scanForbiddenMigrationMarkers(options: SourceScanOptions = {}): SourceScanResult {
  const root = options.root ?? REPOSITORY_ROOT
  const reader = options.reader ?? defaultSourceReader()
  const scan = scanSourceTree({ ...options, reader })
  const unreadable = [...scan.unreadable]
  const hits: string[] = []
  for (const file of scan.files) {
    // A test may legitimately name a forbidden marker to assert its absence;
    // the migration itself must not carry one.
    if (file.includes('.test.')) continue
    const source = readScannedFile(file, reader, unreadable)
    if (source === undefined) continue
    for (const marker of FORBIDDEN_MIGRATION_MARKERS) {
      if (source.includes(marker)) hits.push(`${relative(root, file)}: ${marker}`)
    }
  }
  return { hits: hits.toSorted(), unreadable: unreadable.toSorted() }
}

/**
 * The freshness qualification this parent depends on.
 *
 * It belongs to the #1562 scope branch, so this parent records the dependency
 * instead of re-implementing or re-verifying it: the stale-cache proof is
 * that scope own suite, and duplicating it here would overlap the parent and
 * the child implementation ownership.
 */
export const FRESHNESS_QUALIFICATION = {
  scope: '#1562',
  branch: 'recovery/issue-1562-cloudflare-cpu-hyperdrive-qualification',
  path: 'scripts/cloudflare-cpu-hyperdrive-qualification.ts',
  rule: 'authority-reads-not-cache-disabled',
} as const

/** What a scan actually covered. */
export type SourceScanCoverage = {
  roots: string[]
  extensions: string[]
  skippedDirectories: string[]
  skippedHiddenEntries: boolean
  readsWorkingTree: boolean
  testFilesInDependencyInventory: boolean
  testFilesInMarkerScan: boolean
  narrowed: boolean
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * The source scope a scan actually covered.
 *
 * The coverage is **derived from the scan that ran**, not from the approved
 * scope: a scan that was narrowed to one root reports that root, so a coverage
 * record can never describe a wider scope than the scan that produced it. The
 * skipping is part of the coverage too - the named directories and the hidden
 * entries are not read - so a reader knows what the scan did not see.
 */
export function sourceScanCoverage(options: SourceScanOptions = {}): SourceScanCoverage {
  const roots = [...(options.roots ?? SOURCE_SCAN_ROOTS)]
  const extensions = [...(options.extensions ?? SOURCE_SCAN_EXTENSIONS)]
  return {
    roots,
    extensions,
    skippedDirectories: [...SOURCE_SCAN_SKIPPED_DIRECTORIES],
    // A hidden entry, and everything under it, is never read.
    skippedHiddenEntries: true,
    // The scan reads the working tree and does not consult git, so a generated
    // declaration that names the provider is listed as well.
    readsWorkingTree: true,
    testFilesInDependencyInventory: true,
    testFilesInMarkerScan: false,
    narrowed: !sameList(roots, SOURCE_SCAN_ROOTS) || !sameList(extensions, SOURCE_SCAN_EXTENSIONS),
  }
}

/** Thrown when an acceptance record would be built from a narrowed scan. */
export class SourceScanScopeError extends Error {
  constructor(readonly coverage: SourceScanCoverage) {
    super(
      `the acceptance record requires the approved source scope (roots: ${SOURCE_SCAN_ROOTS.join(', ')}; extensions: ${SOURCE_SCAN_EXTENSIONS.join(', ')}), but this scan covered roots: ${coverage.roots.join(', ')}; extensions: ${coverage.extensions.join(', ')}`
    )
    this.name = 'SourceScanScopeError'
  }
}

/** The inventory record, assembled from the repository's own sources. */
export function railwayMigrationAcceptanceInventory(options: SourceScanOptions = {}): {
  neonProviderDependencies: string[]
  forbiddenMigrationMarkers: string[]
  scanCoverage: SourceScanCoverage
  scanIncomplete: string[]
  freshnessQualification: typeof FRESHNESS_QUALIFICATION
  childScopes: typeof CHILD_SCOPES
  relatedPullRequests: typeof RELATED_PULL_REQUESTS
  gatedAcceptance: typeof GATED_ACCEPTANCE
} {
  const coverage = sourceScanCoverage(options)
  // An acceptance record describes the approved scope. A narrowed scan may be
  // run and reported on its own, but it may not be recorded as the acceptance
  // record: a record that claimed the approved scope over a narrower scan
  // would report coverage the scan never had.
  if (coverage.narrowed) throw new SourceScanScopeError(coverage)
  const dependencies = inventoryNeonProviderDependencies(options)
  const markers = scanForbiddenMigrationMarkers(options)
  return {
    neonProviderDependencies: dependencies.hits,
    forbiddenMigrationMarkers: markers.hits,
    scanCoverage: coverage,
    // Every path the scan could not read. A non-empty list means the scan did
    // not see the whole approved scope, so the record is incomplete and the
    // qualification fails closed on it.
    scanIncomplete: [...new Set([...dependencies.unreadable, ...markers.unreadable])].toSorted(),
    freshnessQualification: FRESHNESS_QUALIFICATION,
    childScopes: CHILD_SCOPES,
    relatedPullRequests: RELATED_PULL_REQUESTS,
    gatedAcceptance: GATED_ACCEPTANCE,
  }
}
