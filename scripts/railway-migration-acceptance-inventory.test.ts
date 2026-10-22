/** Offline checks for the Railway migration acceptance inventory (issue #1564). */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHILD_SCOPES,
  FORBIDDEN_MIGRATION_MARKERS,
  GATED_ACCEPTANCE,
  RELATED_PULL_REQUESTS,
  FRESHNESS_QUALIFICATION,
  SOURCE_SCAN_EXTENSIONS,
  SOURCE_SCAN_ROOTS,
  SourceScanScopeError,
  inventoryNeonProviderDependencies,
  railwayMigrationAcceptanceInventory,
  scanForbiddenMigrationMarkers,
  scanSourceTree,
  sourceScanCoverage,
  type SourceScanReader,
} from './railway-migration-acceptance-inventory.ts'

/** A reader that refuses one subtree and reads the rest, like a permission fault. */
function readerRefusing(paths: readonly string[]): SourceScanReader {
  return {
    readDirectory: (path) => {
      if (paths.includes(path)) throw new Error(`EACCES: permission denied, scandir '${path}'`)
      return readdirSync(path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }))
    },
    readFile: (path) => readFileSync(path, 'utf8'),
  }
}

describe('the Railway migration acceptance inventory', () => {
  test('the remaining Neon and provider-auth dependencies are inventoried', () => {
    const dependencies = inventoryNeonProviderDependencies()
    expect(Array.isArray(dependencies.hits)).toBe(true)
    expect(dependencies.hits.length).toBeGreaterThan(0)
    for (const path of dependencies.hits) {
      expect(path.startsWith('apps/') || path.startsWith('packages/')).toBe(true)
    }
  })

  test('the approved source scope covers the auth package provider configuration and driver', () => {
    // These two files name the provider and its authentication, and an
    // apps-only scan could not see them.
    const dependencies = inventoryNeonProviderDependencies()
    expect(dependencies.hits).toContain('packages/auth/src/config.ts')
    expect(dependencies.hits).toContain('packages/auth/src/neon-driver.ts')
  })

  test('the scan coverage is explicit, and names what it skipped', () => {
    const coverage = sourceScanCoverage()
    expect(coverage.roots).toEqual([...SOURCE_SCAN_ROOTS])
    expect(coverage.extensions).toEqual([...SOURCE_SCAN_EXTENSIONS])
    expect(coverage.skippedDirectories).toContain('node_modules')
    expect(coverage.skippedDirectories).toContain('dist')
    // A hidden entry, and everything under it, is never read.
    expect(coverage.skippedHiddenEntries).toBe(true)
    expect(coverage.readsWorkingTree).toBe(true)
    expect(coverage.testFilesInDependencyInventory).toBe(true)
    expect(coverage.testFilesInMarkerScan).toBe(false)
    expect(coverage.narrowed).toBe(false)
    const record = railwayMigrationAcceptanceInventory()
    expect(record.scanCoverage).toEqual(coverage)
  })

  test('a narrowed scan succeeds and reports the scope it actually covered', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-inventory-narrowed-'))
    try {
      mkdirSync(join(root, 'packages', 'auth', 'src'), { recursive: true })
      writeFileSync(
        join(root, 'packages', 'auth', 'src', 'config.ts'),
        'export const provider = process.env.NEON_AUTH_TOKEN\n'
      )
      // The narrowed scan itself succeeds.
      const dependencies = inventoryNeonProviderDependencies({ root, roots: ['packages'] })
      expect(dependencies.hits).toEqual([join('packages', 'auth', 'src', 'config.ts')])
      expect(dependencies.unreadable).toEqual([])
      // And the coverage it reports is the narrowed one, not the approved one.
      const coverage = sourceScanCoverage({ root, roots: ['packages'] })
      expect(coverage.roots).toEqual(['packages'])
      expect(coverage.narrowed).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a narrowed scan cannot produce the acceptance record', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-inventory-scope-guard-'))
    try {
      // A record that claimed the approved scope over a narrower scan would
      // report coverage the scan never had, so it is refused.
      expect(() => railwayMigrationAcceptanceInventory({ root, roots: ['packages'] })).toThrow(
        SourceScanScopeError
      )
      expect(() => railwayMigrationAcceptanceInventory({ root, extensions: ['.ts'] })).toThrow(
        SourceScanScopeError
      )
      // The approved scope still produces the record.
      expect(railwayMigrationAcceptanceInventory({ root }).scanCoverage.narrowed).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('no legacy import, dual write or old-data reconciliation is present', () => {
    const markers = scanForbiddenMigrationMarkers()
    expect(markers.hits).toEqual([])
    expect(markers.unreadable).toEqual([])
    expect(FORBIDDEN_MIGRATION_MARKERS.length).toBeGreaterThan(0)
  })

  test('a missing root is reported as incomplete, not as an empty scan', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-inventory-missing-'))
    try {
      const scan = scanSourceTree({ root, roots: ['not-there'] })
      expect(scan.files).toEqual([])
      // The unreadable root is named, so the scan cannot be read as "nothing here".
      expect(scan.unreadable).toEqual(['not-there'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an unreadable subtree is reported, not read as clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-inventory-unreadable-'))
    try {
      mkdirSync(join(root, 'apps'), { recursive: true })
      mkdirSync(join(root, 'apps', 'locked'), { recursive: true })
      writeFileSync(join(root, 'apps', 'readable.ts'), 'export const value = 1\n')
      writeFileSync(join(root, 'apps', 'locked', 'hidden.ts'), 'export const hidden = 1\n')
      const reader = readerRefusing([join(root, 'apps', 'locked')])
      const scan = scanSourceTree({ root, reader, roots: ['apps'] })
      expect(scan.files.length).toBe(1)
      expect(scan.unreadable).toEqual([join('apps', 'locked')])
      const dependencies = inventoryNeonProviderDependencies({ root, reader, roots: ['apps'] })
      expect(dependencies.unreadable.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a temporary source root is scanned for both the provider and the markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-inventory-temporary-'))
    try {
      mkdirSync(join(root, 'packages', 'auth', 'src'), { recursive: true })
      writeFileSync(
        join(root, 'packages', 'auth', 'src', 'config.ts'),
        'export const provider = process.env.NEON_AUTH_TOKEN\n'
      )
      writeFileSync(
        join(root, 'packages', 'auth', 'src', 'migration.ts'),
        'export const write = { dualWrite: true }\n'
      )
      // The temporary root holds the packages part of the scope only, so the
      // scan is rooted at that part; a root that is not there would be reported.
      const dependencies = inventoryNeonProviderDependencies({ root, roots: ['packages'] })
      expect(dependencies.hits).toEqual([join('packages', 'auth', 'src', 'config.ts')])
      expect(dependencies.unreadable).toEqual([])
      const markers = scanForbiddenMigrationMarkers({ root, roots: ['packages'] })
      expect(markers.hits).toEqual([
        `${join('packages', 'auth', 'src', 'migration.ts')}: dualWrite`,
      ])
      expect(markers.unreadable).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the freshness qualification this parent depends on is recorded, not re-verified', () => {
    // The stale-cache proof belongs to the #1562 scope's own suite. This
    // inventory records that dependency instead of re-implementing it, so it
    // asserts the declaration and never the child's acceptance.
    expect(FRESHNESS_QUALIFICATION.scope).toBe('#1562')
    expect(FRESHNESS_QUALIFICATION.branch).toBe(
      'recovery/issue-1562-cloudflare-cpu-hyperdrive-qualification'
    )
    expect(FRESHNESS_QUALIFICATION.path).toBe('scripts/cloudflare-cpu-hyperdrive-qualification.ts')
    expect(FRESHNESS_QUALIFICATION.rule).toBe('authority-reads-not-cache-disabled')
  })

  test('the child scopes and the related pull requests are recorded', () => {
    expect(CHILD_SCOPES.map((scope) => scope.issue)).toEqual(['#1560', '#1561', '#1562'])
    expect(RELATED_PULL_REQUESTS.map((pull) => pull.number)).toEqual([1515, 1525])
    for (const pull of RELATED_PULL_REQUESTS) expect(pull.head.length).toBeGreaterThan(7)
  })

  test('every live acceptance stays gated', () => {
    for (const gate of GATED_ACCEPTANCE) {
      expect(['gated', 'not authorized']).toContain(gate.state)
    }
    expect(GATED_ACCEPTANCE.length).toBeGreaterThanOrEqual(4)
  })

  test('the inventory record is complete', () => {
    const record = railwayMigrationAcceptanceInventory()
    // The inventory reports what is left; it does not assert a count, because
    // the count moves with the other lanes' source work.
    expect(Array.isArray(record.neonProviderDependencies)).toBe(true)
    expect(record.forbiddenMigrationMarkers).toEqual([])
    // The scan saw the whole approved scope: nothing was unreadable, so the
    // record is complete rather than incomplete-by-silence.
    expect(record.scanIncomplete).toEqual([])
    expect(record.freshnessQualification).toEqual(FRESHNESS_QUALIFICATION)
    expect(record.childScopes.length).toBe(3)
    expect(record.relatedPullRequests.length).toBe(2)
    expect(record.gatedAcceptance.length).toBeGreaterThanOrEqual(4)
  })
})
