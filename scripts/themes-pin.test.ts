import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const UI_PACKAGE = '@adea-ai/ui'
const THEMES_PACKAGE = '@adea-ai/themes'

// PR #1139: the workspace pinned @adea-ai/themes 0.9.7 while the installed
// @adea-ai/ui declared ^0.9.10, so Bun dual-installed the catalogue and the
// generated theme projections silently mixed the two copies. This guard keeps
// that failure from recurring: every copy of @adea-ai/themes that the
// lockfile actually installs must satisfy the range the installed
// @adea-ai/ui declares for it. Reading the installed tree (not the manifests)
// means the check tracks what Bun resolved, exactly where the drift appeared.

type Version = readonly [number, number, number]

function parseVersion(input: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(input.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareVersions(left: Version, right: Version): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

/**
 * The subset of node-semver range syntax published dependencies actually use:
 * `^`, `~`, exact, comparators, `||` alternatives, and x-ranges. Unknown
 * syntax fails closed so the guard cannot pass by not understanding a range.
 */
function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false
  const alternatives = range.trim() === '' ? ['*'] : range.split('||')
  return alternatives.some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((atom) => matchesComparator(parsed, atom))
  )
}

function matchesComparator(version: Version, atom: string): boolean {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(
    atom.trim()
  )
  // A range syntax this checker does not understand must fail closed: an
  // unparsed atom would otherwise silently bless every installed version.
  if (!match) return false
  const operator = match[1] ?? ''
  const rawParts = [match[2], match[3], match[4]]
  // The first segment the atom leaves open (3 = fully specified, 0 = "*").
  const unspecifiedAt = rawParts.findIndex((part) => part === undefined || /[xX*]/.test(part))
  const openAt = unspecifiedAt === -1 ? 3 : unspecifiedAt
  const floor = rawParts.map((part) =>
    part === undefined || /[xX*]/.test(part) ? 0 : Number(part)
  ) as Version

  // A wildcard major ("*", "x") bounds nothing; other operators over it are
  // unknown syntax, so fail closed.
  if (openAt === 0) return operator === '' || operator === '>='

  const bounded = (upper: Version) => atLeast(version, floor) && below(version, upper)
  if (operator === '^' || operator === '~') {
    // npm desugars open segments under ^/~ by stopping before the next bump:
    // "^1.2" ends <2.0.0 (an open patch under a nonzero major widens to the
    // next major), "^0.2" and "~1.2.x" end before the next minor.
    if (openAt < 3) {
      if (operator === '^' && openAt === 2 && floor[0] > 0) return bounded(bumpTo(floor, 0))
      return bounded(bumpTo(floor, (openAt - 1) as 0 | 1))
    }
    return bounded(operator === '^' ? caretUpper(floor) : bumpTo(floor, 1))
  }
  if (operator === '') {
    // A bare partial version is an x-range ("0.9" means ">=0.9.0 <0.10.0");
    // a bare full version is exact.
    if (openAt < 3) return bounded(bumpTo(floor, (openAt - 1) as 0 | 1))
    return compareVersions(version, floor) === 0
  }

  const order = compareVersions(version, floor)
  if (operator === '>=') return order >= 0
  if (operator === '>') return order > 0
  if (operator === '<') return order < 0
  return order <= 0
}

/** npm caret semantics: bump the leftmost nonzero segment. */
function caretUpper(version: Version): Version {
  if (version[0] > 0) return [version[0] + 1, 0, 0]
  if (version[1] > 0) return [0, version[1] + 1, 0]
  return [0, 0, version[2] + 1]
}

function bumpTo(version: Version, segment: 0 | 1 | 2): Version {
  if (segment === 0) return [version[0] + 1, 0, 0]
  if (segment === 1) return [version[0], version[1] + 1, 0]
  return [version[0], version[1], version[2] + 1]
}

function atLeast(version: Version, lower: Version): boolean {
  return compareVersions(version, lower) >= 0
}

function below(version: Version, upper: Version): boolean {
  return compareVersions(version, upper) < 0
}

// Bun's isolated linker materialises a package copy per resolved version, so
// a dual install leaves two physical directories. Walk the repo for
// node_modules boundaries without descending into dependency trees: each
// node_modules contributes its direct scoped link plus any matching
// `node_modules/.bun/<pkg>@<version>/node_modules/<pkg>` store copy.
const SKIP_DIRECTORIES = new Set([
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'target',
  'test-results',
])

function collectInstalledCopies(rootDirectory: string, packageName: string): string[] {
  const segments = packageName.split('/')
  const storePrefix = packageName.replace('/', '+')
  const found: string[] = []

  const visitNodeModules = (nodeModules: string) => {
    const direct = join(nodeModules, ...segments)
    if (existsSync(join(direct, 'package.json'))) found.push(direct)
    const store = join(nodeModules, '.bun')
    if (!existsSync(store)) return
    for (const entry of readdirSync(store, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${storePrefix}@`)) continue
      const nested = join(store, entry.name, 'node_modules', ...segments)
      if (existsSync(join(nested, 'package.json'))) found.push(nested)
    }
  }

  const visit = (directory: string, depth: number) => {
    if (depth > 6) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules') {
        visitNodeModules(join(directory, entry.name))
        continue
      }
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue
      visit(join(directory, entry.name), depth + 1)
    }
  }

  visit(rootDirectory, 0)

  // Workspace links alias one physical store copy; audit each copy once.
  const physical = new Set<string>()
  return found.filter((directory) => {
    let real = directory
    try {
      real = realpathSync(directory)
    } catch {
      // An unreadable path still deserves an audit attempt.
    }
    if (physical.has(real)) return false
    physical.add(real)
    return true
  })
}

function readManifestField(directory: string, field: 'version' | 'name'): string {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
    return typeof manifest[field] === 'string' ? (manifest[field] as string) : ''
  } catch {
    return ''
  }
}

type GuardReport = {
  /** Range each installed @adea-ai/ui copy declares for @adea-ai/themes. */
  declaredRanges: { uiVersion: string; range: string }[]
  /** Every physical @adea-ai/themes copy the install produced. */
  installedCopies: { path: string; version: string }[]
  violations: string[]
}

function auditThemesPin(rootDirectory: string): GuardReport {
  const declaredRanges: GuardReport['declaredRanges'] = []
  for (const directory of collectInstalledCopies(rootDirectory, UI_PACKAGE)) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      version?: string
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const range =
      manifest.dependencies?.[THEMES_PACKAGE] ?? manifest.peerDependencies?.[THEMES_PACKAGE]
    if (range) declaredRanges.push({ uiVersion: manifest.version ?? '', range })
  }

  const installedCopies = collectInstalledCopies(rootDirectory, THEMES_PACKAGE).map(
    (directory) => ({
      path: directory,
      version: readManifestField(directory, 'version'),
    })
  )

  const violations: string[] = []
  for (const copy of installedCopies) {
    const location = relative(rootDirectory, copy.path) || copy.path
    if (!parseVersion(copy.version)) {
      violations.push(`${location}: unreadable @adea-ai/themes package version`)
      continue
    }
    for (const { uiVersion, range } of declaredRanges) {
      if (satisfiesRange(copy.version, range)) continue
      violations.push(
        `${location}: installed @adea-ai/themes ${copy.version} does not satisfy "${range}" ` +
          `declared by installed @adea-ai/ui ${uiVersion} — Bun dual-installs the theme ` +
          `catalogue and projections mix the copies (the PR #1139 drift)`
      )
    }
  }
  return { declaredRanges, installedCopies, violations }
}

function writePackageManifest(directory: string, manifest: Record<string, unknown>) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest)}\n`)
}

function mkdtemp(): string {
  // Resolve through the macOS /var → /private/var alias so every path the
  // guard reports stays comparable inside the fixture.
  return realpathSync(mkdtempSync(join(tmpdir(), 'adea-themes-pin-')))
}

describe('themes pin guard', () => {
  test('every installed @adea-ai/themes copy satisfies the range installed @adea-ai/ui declares', () => {
    const report = auditThemesPin(root)
    // Fail closed when the scan finds nothing: a guard that inspects an empty
    // tree proves nothing about the install.
    expect(report.declaredRanges.length).toBeGreaterThan(0)
    expect(report.installedCopies.length).toBeGreaterThan(0)
    expect(report.violations).toEqual([])
  })

  test('the range checker reads npm ranges the way the package manager does', () => {
    // The exact #1139 drift: an exact pin below ui's caret floor.
    expect(satisfiesRange('0.9.7', '^0.9.10')).toBe(false)
    expect(satisfiesRange('0.9.10', '^0.9.10')).toBe(true)
    // 0.x carets lock the minor; 1.x carets lock the major.
    expect(satisfiesRange('0.10.0', '^0.9.10')).toBe(false)
    expect(satisfiesRange('1.2.9', '^1.2.3')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false)
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false)
    expect(satisfiesRange('0.9.10', '0.9.10')).toBe(true)
    expect(satisfiesRange('0.9.11', '0.9.10')).toBe(false)
    expect(satisfiesRange('0.9.0', '>=0.9.0 <0.10.0')).toBe(true)
    expect(satisfiesRange('0.10.0', '>=0.9.0 <0.10.0')).toBe(false)
    expect(satisfiesRange('1.5.0', '^1.2.0 || ^2.0.0')).toBe(true)
    expect(satisfiesRange('3.0.0', '^1.2.0 || ^2.0.0')).toBe(false)
    expect(satisfiesRange('1.2.3', '*')).toBe(true)
    expect(satisfiesRange('1.2.3', '')).toBe(true)
    // x-ranges and partial versions.
    expect(satisfiesRange('1.2.9', '1.2.x')).toBe(true)
    expect(satisfiesRange('1.3.0', '1.2.x')).toBe(false)
    expect(satisfiesRange('0.9.7', '0.9')).toBe(true)
    expect(satisfiesRange('0.10.0', '0.9')).toBe(false)
    expect(satisfiesRange('1.9.9', '^1.2')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.2')).toBe(false)
    expect(satisfiesRange('0.2.5', '^0.2')).toBe(true)
    expect(satisfiesRange('0.3.0', '^0.2')).toBe(false)
    expect(satisfiesRange('0.5.0', '^0')).toBe(true)
    expect(satisfiesRange('1.0.0', '^0')).toBe(false)
    expect(satisfiesRange('1.2.9', '~1.2.x')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.x')).toBe(false)
    expect(satisfiesRange('1.9.9', '~1')).toBe(true)
    expect(satisfiesRange('2.0.0', '~1')).toBe(false)
    // Unparseable input fails closed on both sides.
    expect(satisfiesRange('not-a-version', '^0.9.10')).toBe(false)
    expect(satisfiesRange('0.9.10', 'latest')).toBe(false)
  })

  test('flags a dual-catalogue install shaped like #1139 and passes a clean tree', () => {
    const fixture = mkdtemp()
    try {
      // The drift shape: one healthy workspace copy, one stale store copy
      // nested under the isolated linker, next to ui declaring ^0.9.10.
      writePackageManifest(join(fixture, 'node_modules/@adea-ai/ui'), {
        name: UI_PACKAGE,
        version: '0.120.0',
        dependencies: { [THEMES_PACKAGE]: '^0.9.10' },
      })
      writePackageManifest(
        join(fixture, 'node_modules/.bun/@adea-ai+themes@0.9.7/node_modules/@adea-ai/themes'),
        { name: THEMES_PACKAGE, version: '0.9.7' }
      )
      writePackageManifest(join(fixture, 'packages/ui/node_modules/@adea-ai/themes'), {
        name: THEMES_PACKAGE,
        version: '0.9.10',
      })

      const drifted = auditThemesPin(fixture)
      expect(drifted.violations).toHaveLength(1)
      expect(drifted.violations[0]).toContain('0.9.7')
      expect(drifted.violations[0]).toContain('^0.9.10')

      rmSync(join(fixture, 'node_modules/.bun'), { recursive: true, force: true })
      expect(auditThemesPin(fixture).violations).toEqual([])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('an install with no ui-declared range fails loudly instead of passing', () => {
    const fixture = mkdtemp()
    try {
      writePackageManifest(join(fixture, 'node_modules/@adea-ai/ui'), {
        name: UI_PACKAGE,
        version: '1.0.0',
      })
      writePackageManifest(join(fixture, 'node_modules/@adea-ai/themes'), {
        name: THEMES_PACKAGE,
        version: '0.9.10',
      })
      // If ui stops declaring a range the guard loses its contract; the
      // sanity assertions in the repo test keep that from passing silently.
      const report = auditThemesPin(fixture)
      expect(report.declaredRanges).toEqual([])
      expect(report.installedCopies.length).toBeGreaterThan(0)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
