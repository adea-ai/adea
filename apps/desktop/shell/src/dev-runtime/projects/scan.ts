/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Prune-first monorepo scanner semantics substantially translated and reduced
 * from KiroCrew src/kiro_crew/project_scan.py at revision
 * 283e136c0f902e965a535a7c9548c57c7504fed0 (Apache-2.0; see NOTICE). The
 * 1,662-line Python distribution is deliberately NOT translated wholesale:
 * only the bounded walker, workspace-manifest parsing, ignore pruning, and
 * budget/cancellation behavior survive, re-expressed as small typed modules
 * against Adea's authorized-root authority. See
 * docs/research/dev-view-donor-audit.md (#398).
 *
 * Scanner contract (spec: "Project registry and scanner"):
 * - parse declared workspaces/config rather than every package.json;
 * - honor .gitignore and prune .git, dependency, build, cache, coverage, and
 *   binary/vendor directories before descent;
 * - never follow symlinks;
 * - budgets: depth 16, examined entries 100,000, discovered packages 10,000,
 *   manifest bytes 2 MiB/file, elapsed 10 seconds per root;
 * - cancellation is checked at least every 100 examined entries;
 * - budget exhaustion and cancellation return partial results with
 *   diagnostics, never a silent truncation and never a thrown failure for a
 *   successful partial scan;
 * - scanning never executes install/bootstrap commands.
 */
import { lstatSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

export type ScanBudgets = Readonly<{
  maxDepth: number
  maxExaminedEntries: number
  maxPackages: number
  maxManifestBytes: number
  timeBudgetMs: number
}>

export const DEFAULT_SCAN_BUDGETS: ScanBudgets = {
  maxDepth: 16,
  maxExaminedEntries: 100_000,
  maxPackages: 10_000,
  maxManifestBytes: 2 * 1024 * 1024,
  timeBudgetMs: 10_000,
}

/** Injected cancellation probe; consulted at least every 100 entries. */
export type ScanShouldCancel = () => boolean

export type ScanCandidate = {
  name: string
  relativeDir: string
  manifestPath: string
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'cargo' | 'pip' | 'poetry' | 'uv' | 'unknown'
  languages: string[]
  suggestedScripts: string[]
  diagnostics: string[]
}

export type DirectoryScanResult = Readonly<{
  entries: readonly ScanCandidate[]
  /** True when a budget or cancellation stopped the scan early. */
  partial: boolean
  /** Scan-level diagnostics (`budget_exhausted`, `cancelled`, …). */
  diagnostics: readonly string[]
  examinedEntries: number
  cancelled: boolean
}>

/** Standard heavy/generated directories pruned before descent, always. */
const ALWAYS_PRUNED: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'vendor',
  'Pods',
  '.gradle',
])

const ROOT_WORKSPACE_MANIFESTS = [
  'package.json',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'pyproject.toml',
] as const

const PACKAGE_MANIFESTS = ['package.json', 'Cargo.toml', 'pyproject.toml'] as const

const INTERESTING_SCRIPTS = ['build', 'check', 'test', 'lint', 'dev'] as const

/* Internal sentinels: they stop the walker and become diagnostics, never
 * errors that escape the module. */
class BudgetStop extends Error {}
class CancelledStop extends Error {}

type WalkState = {
  budgets: ScanBudgets
  examined: number
  entries: ScanCandidate[]
  diagnostics: Set<string>
  cancelled: boolean
  deadline: number
  shouldCancel?: ScanShouldCancel
  partial: boolean
}

function charge(state: WalkState, count = 1): void {
  state.examined += count
  if (state.examined > state.budgets.maxExaminedEntries) {
    state.partial = true
    state.diagnostics.add('budget_exhausted')
    throw new BudgetStop()
  }
  // Cancellation is checked at least every 100 examined entries, and once
  // per directory descent so small walks still observe it promptly.
  if (state.examined % 100 === 0 || state.examined === count) {
    if (state.shouldCancel?.() === true) {
      state.cancelled = true
      state.partial = true
      state.diagnostics.add('cancelled')
      throw new CancelledStop()
    }
    if (Date.now() > state.deadline) {
      state.partial = true
      state.diagnostics.add('budget_exhausted')
      throw new BudgetStop()
    }
  }
}

// ─── .gitignore subset ───────────────────────────────────────────────────────

type IgnoreRule = {
  /** RegExp over a '/'-separated relative path (anchored) or a basename. */
  source: RegExp
  anchored: boolean
  dirOnly: boolean
}

/**
 * A deliberately small .gitignore subset: comments, blank lines, `*`/`?`/`**`
 * globs, trailing-/ directory rules, and name or anchored patterns. Negation
 * (`!`) is not silently ignored — it is reported, because silently
 * over-pruning would hide importable packages from the preview.
 */
function parseIgnoreFile(content: string, where: string, state: WalkState): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('!')) {
      state.diagnostics.add(`gitignore_negation_unsupported:${where}`)
      continue
    }
    let pattern = line
    const dirOnly = pattern.endsWith('/')
    if (dirOnly) pattern = pattern.slice(0, -1)
    const anchored = pattern.includes('/')
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\uE000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\uE000/g, '.*')
    rules.push({
      source: new RegExp(`^${escaped}$`),
      anchored,
      dirOnly,
    })
  }
  return rules
}

function isIgnored(
  relativePath: string,
  basename: string,
  isDirectory: boolean,
  ruleSets: readonly IgnoreRule[][]
): boolean {
  for (const rules of ruleSets) {
    for (const rule of rules) {
      if (rule.dirOnly && !isDirectory) continue
      if (rule.anchored) {
        if (rule.source.test(relativePath)) return true
        if (rule.source.test(`${relativePath}/`)) return true
      } else if (rule.source.test(basename)) {
        return true
      }
    }
  }
  return false
}

// ─── Manifest parsing (bounded line/JSON readers) ───────────────────────────

type ManifestInfo = {
  name?: string
  languages: string[]
  packageManager: ScanCandidate['packageManager']
  suggestedScripts: string[]
  workspaces?: readonly string[]
  diagnostics: string[]
}

function readManifest(
  path: string,
  maxManifestBytes: number
): { content: string } | { error: string } {
  let size: number | undefined
  try {
    size = statSync(path, { throwIfNoEntry: false })?.size
  } catch {
    return { error: 'manifest_unreadable' }
  }
  if (size === undefined) return { error: 'manifest_unreadable' }
  if (size > maxManifestBytes) return { error: 'manifest_too_large' }
  try {
    return { content: readFileSync(path, 'utf8') }
  } catch {
    return { error: 'manifest_unreadable' }
  }
}

function parsePackageJsonManifest(
  content: string,
  dirEntries: ReadonlySet<string>,
  state: WalkState
): ManifestInfo {
  const diagnostics: string[] = []
  let parsed: {
    name?: unknown
    workspaces?: unknown
    scripts?: unknown
  }
  try {
    parsed = JSON.parse(content) as typeof parsed
  } catch {
    return {
      languages: [],
      packageManager: 'unknown',
      suggestedScripts: [],
      diagnostics: ['malformed_manifest'],
    }
  }
  const languages: string[] = []
  if (dirEntries.has('tsconfig.json')) languages.push('typescript')
  if (dirEntries.has('jsconfig.json')) languages.push('javascript')
  let packageManager: ManifestInfo['packageManager'] = 'unknown'
  if (dirEntries.has('pnpm-lock.yaml')) packageManager = 'pnpm'
  else if (dirEntries.has('yarn.lock')) packageManager = 'yarn'
  else if (dirEntries.has('bun.lock') || dirEntries.has('bun.lockb')) packageManager = 'bun'
  else if (dirEntries.has('package-lock.json')) packageManager = 'npm'
  const suggestedScripts: string[] = []
  if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) {
    const scriptKeys = Object.keys(parsed.scripts as Record<string, unknown>)
    for (const script of INTERESTING_SCRIPTS)
      if (scriptKeys.includes(script)) suggestedScripts.push(script)
  }
  charge(state)
  let workspaces: readonly string[] | undefined
  const rawWorkspaces = parsed.workspaces
  if (Array.isArray(rawWorkspaces))
    workspaces = rawWorkspaces.filter((entry): entry is string => typeof entry === 'string')
  else if (
    rawWorkspaces &&
    typeof rawWorkspaces === 'object' &&
    Array.isArray((rawWorkspaces as { packages?: unknown }).packages)
  ) {
    workspaces = (rawWorkspaces as { packages: unknown[] }).packages.filter(
      (entry): entry is string => typeof entry === 'string'
    )
  } else if (rawWorkspaces !== undefined) diagnostics.push('malformed_manifest')
  return {
    ...(typeof parsed.name === 'string' && parsed.name.length > 0 ? { name: parsed.name } : {}),
    languages,
    packageManager,
    suggestedScripts,
    ...(workspaces ? { workspaces } : {}),
    diagnostics,
  }
}

/**
 * Section-aware line parser for the small TOML subset the scanner needs:
 * `[workspace] members`, `[package] name`, `[project] name`, and
 * `[tool.uv.workspace] members`. Anything else in the file is ignored; a
 * structurally broken members array reports `malformed_manifest`.
 */
function parseTomlSections(
  content: string
): Map<string, { name?: string; members?: string[]; membersMalformed?: boolean }> {
  const sections = new Map<
    string,
    { name?: string; members?: string[]; membersMalformed?: boolean }
  >()
  let current = ''
  let currentMembers: string[] | undefined
  let inMembersArray = false
  const commit = () => {
    if (current && currentMembers !== undefined) {
      sections.set(current, { members: currentMembers })
    }
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const header = line.match(/^\[(.+)\]$/)
    if (header) {
      commit()
      current = header[1]!.trim()
      currentMembers = undefined
      inMembersArray = false
      if (!sections.has(current)) sections.set(current, {})
      continue
    }
    const memberMatch = line.match(/^members\s*=\s*(.*)$/)
    if (memberMatch && (current === 'workspace' || current === 'tool.uv.workspace')) {
      const rest = memberMatch[1]!.trim()
      if (rest === '[') {
        currentMembers = []
        inMembersArray = true
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        currentMembers = parseTomlStringArray(rest)
        if (currentMembers === undefined) sections.set(current, { membersMalformed: true })
        else sections.set(current, { members: currentMembers })
        currentMembers = undefined
      } else {
        sections.set(current, { membersMalformed: true })
      }
      continue
    }
    if (inMembersArray) {
      if (line === ']') {
        inMembersArray = false
        continue
      }
      const item = line.match(/^"([^"]*)"\s*,?\s*$/) ?? line.match(/^'([^']*)'\s*,?\s*$/)
      if (item) currentMembers = [...(currentMembers ?? []), item[1]!]
      else if (current) sections.set(current, { membersMalformed: true })
      continue
    }
    const nameMatch = line.match(/^name\s*=\s*"([^"]*)"$/)
    if (nameMatch && (current === 'package' || current === 'project')) {
      const section = sections.get(current) ?? {}
      sections.set(current, { ...section, name: nameMatch[1] })
    }
  }
  commit()
  return sections
}

function parseTomlStringArray(text: string): string[] | undefined {
  const inner = text.slice(1, -1)
  if (inner.trim() === '') return []
  const items: string[] = []
  for (const piece of inner.split(',')) {
    const item = piece.trim()
    const quoted = item.match(/^"([^"]*)"$/) ?? item.match(/^'([^']*)'$/)
    if (!quoted) return undefined
    items.push(quoted[1]!)
  }
  return items
}

/**
 * Minimal pnpm-workspace.yaml reader: the `packages:` block list. A YAML
 * parser is deliberately not added as a dependency; anything the reader
 * cannot understand reports `malformed_manifest` instead of guessing.
 */
function parsePnpmWorkspace(content: string): { members?: string[]; malformed: boolean } {
  const lines = content.split('\n')
  const packagesIndex = lines.findIndex((line) => /^packages\s*:\s*(#.*)?$/.test(line.trim()))
  if (packagesIndex < 0) return { malformed: true }
  const members: string[] = []
  for (const rawLine of lines.slice(packagesIndex + 1)) {
    if (rawLine.trim() === '') continue
    if (!/^\s+-\s*/.test(rawLine)) break
    const item = rawLine.replace(/^\s+-\s*/, '').trim()
    // Quoted scalars, or bare scalars without YAML flow characters; a flow
    // sequence such as `[unclosed` is malformed, not a member pattern.
    const scalar =
      item.match(/^'([^']+)'$/) ??
      item.match(/^"([^"]+)"$/) ??
      item.match(/^([^\s'"[\]{},][^\s]*)$/)
    if (!scalar) return { malformed: true }
    members.push(scalar[1]!)
  }
  return { members, malformed: false }
}

// ─── Candidate construction ─────────────────────────────────────────────────

function manifestInfoForDir(
  absoluteDir: string,
  relativeDir: string,
  dirEntries: ReadonlySet<string>,
  state: WalkState,
  rootFiles: ReadonlySet<string> = dirEntries,
  managerHint?: ScanCandidate['packageManager']
): ScanCandidate | undefined {
  if (dirEntries.has('package.json')) {
    const manifestPath = relativeDir === '' ? 'package.json' : `${relativeDir}/package.json`
    const read = readManifest(join(absoluteDir, 'package.json'), state.budgets.maxManifestBytes)
    if ('error' in read) {
      return {
        name: basenameOf(relativeDir),
        relativeDir,
        manifestPath,
        packageManager: 'unknown',
        languages: [],
        suggestedScripts: [],
        diagnostics: [read.error],
      }
    }
    const info = parsePackageJsonManifest(read.content, dirEntries, state)
    const local =
      info.packageManager !== 'unknown' ? info.packageManager : lockfileOf(dirEntries, rootFiles)
    return {
      name: info.name ?? basenameOf(relativeDir),
      relativeDir,
      manifestPath,
      // Monorepo members carry no lockfile of their own: the workspace
      // root's lockfile, then the declaring tool, is the package manager
      // truth for them.
      packageManager: local !== 'unknown' ? local : (managerHint ?? 'unknown'),
      languages: info.languages,
      suggestedScripts: info.suggestedScripts,
      diagnostics: [...info.diagnostics],
    }
  }
  if (dirEntries.has('Cargo.toml')) {
    const manifestPath = relativeDir === '' ? 'Cargo.toml' : `${relativeDir}/Cargo.toml`
    const read = readManifest(join(absoluteDir, 'Cargo.toml'), state.budgets.maxManifestBytes)
    if ('error' in read) {
      return candidateFromError(read.error, relativeDir, manifestPath)
    }
    const sections = parseTomlSections(read.content)
    if (sections.get('workspace')?.membersMalformed) {
      state.diagnostics.add(`malformed_manifest:${manifestPath}`)
    }
    // A [workspace]-only root orchestrates members but is not itself a
    // package; only roots with a [package] section are candidates.
    if (!sections.has('package')) return undefined
    charge(state)
    return {
      name: sections.get('package')?.name ?? basenameOf(relativeDir),
      relativeDir,
      manifestPath,
      packageManager: 'cargo',
      languages: ['rust'],
      suggestedScripts: [],
      diagnostics: [],
    }
  }
  if (dirEntries.has('pyproject.toml')) {
    const manifestPath = relativeDir === '' ? 'pyproject.toml' : `${relativeDir}/pyproject.toml`
    const read = readManifest(join(absoluteDir, 'pyproject.toml'), state.budgets.maxManifestBytes)
    if ('error' in read) {
      return candidateFromError(read.error, relativeDir, manifestPath)
    }
    const sections = parseTomlSections(read.content)
    // A [tool.uv.workspace]-only root declares members but is not a package.
    if (!sections.has('project') && !sections.has('tool.poetry')) return undefined
    charge(state)
    const packageManager =
      sections.has('tool.uv') || sections.has('tool.uv.workspace')
        ? 'uv'
        : sections.has('tool.poetry')
          ? 'poetry'
          : managerHint === 'uv' || managerHint === 'poetry'
            ? managerHint
            : 'pip'
    return {
      name: sections.get('project')?.name ?? basenameOf(relativeDir),
      relativeDir,
      manifestPath,
      packageManager,
      languages: ['python'],
      suggestedScripts: [],
      diagnostics: [],
    }
  }
  return undefined
}

const LOCKFILES: ReadonlyArray<readonly [string, ScanCandidate['packageManager']]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

function lockfileOf(
  dirEntries: ReadonlySet<string>,
  rootFiles: ReadonlySet<string>
): ScanCandidate['packageManager'] {
  for (const [name, manager] of LOCKFILES) {
    if (dirEntries.has(name) || rootFiles.has(name)) return manager
  }
  return 'unknown'
}

function candidateFromError(
  error: string,
  relativeDir: string,
  manifestPath: string
): ScanCandidate {
  return {
    name: basenameOf(relativeDir),
    relativeDir,
    manifestPath,
    packageManager: 'unknown',
    languages: [],
    suggestedScripts: [],
    diagnostics: [error],
  }
}

function basenameOf(relativeDir: string): string {
  if (relativeDir === '') return '.'
  const segments = relativeDir.split('/')
  return segments[segments.length - 1]!
}

// ─── Directory listing with prune-first rules ────────────────────────────────

type DirListing = {
  /** Directory entries keyed by basename (pruned/ignored/symlinks removed). */
  subdirs: Map<string, string>
  files: Set<string>
  ignoreRules: IgnoreRule[][]
}

/**
 * List one directory under the scanner's prune-first rules: symlinks are
 * never followed, standard heavy directories are pruned before descent, and
 * the directory's own .gitignore is parsed into the active rule stack.
 */
function listDir(
  absoluteDir: string,
  relativeDir: string,
  parentRules: readonly IgnoreRule[][],
  state: WalkState
): DirListing {
  charge(state)
  let dirents: Dirent[]
  try {
    dirents = readdirSync(absoluteDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    state.diagnostics.add(`unreadable_dir:${relativeDir === '' ? '.' : relativeDir}`)
    return { subdirs: new Map(), files: new Set(), ignoreRules: [...parentRules] }
  }
  const subdirs = new Map<string, string>()
  const files = new Set<string>()
  // The directory's own .gitignore applies to its own entries, so it is
  // parsed before classification and stacked on the inherited rules.
  let ignoreRules = [...parentRules]
  const ignoreRead = readManifest(join(absoluteDir, '.gitignore'), state.budgets.maxManifestBytes)
  if ('content' in ignoreRead) {
    ignoreRules = [
      ...ignoreRules,
      parseIgnoreFile(ignoreRead.content, relativeDir === '' ? '.' : relativeDir, state),
    ]
  }
  for (const dirent of dirents) {
    charge(state)
    const relative = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`
    // Symlink policy: never follow, whatever the entry type.
    if (dirent.isSymbolicLink()) continue
    if (dirent.isDirectory()) {
      if (ALWAYS_PRUNED.has(dirent.name)) continue
      if (isIgnored(relative, dirent.name, true, ignoreRules)) continue
      subdirs.set(dirent.name, relative)
      continue
    }
    if (dirent.isFile()) {
      if (isIgnored(relative, dirent.name, false, ignoreRules)) continue
      files.add(dirent.name)
    }
  }
  return { subdirs, files, ignoreRules }
}

// ─── Workspace declaration expansion ─────────────────────────────────────────

/**
 * Resolve declared workspace member patterns ('packages/*', literal paths,
 * '**' descents) against the authorized root, honoring the same prune rules
 * as the walker. Missing literal members are reported; glob patterns that
 * match nothing are ordinary empty results.
 */
function expandMemberPattern(
  root: string,
  pattern: string,
  parentRules: readonly IgnoreRule[][],
  state: WalkState
): { dirs: string[]; missingLiteral: boolean } {
  const segments = pattern.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    state.diagnostics.add(`workspace_member_outside_root:${pattern}`)
    return { dirs: [], missingLiteral: false }
  }
  const results: string[] = []
  const walk = (
    absoluteDir: string,
    relativeDir: string,
    remaining: readonly string[],
    rules: readonly IgnoreRule[][],
    depth: number
  ): void => {
    if (state.entries.length + results.length >= state.budgets.maxPackages) {
      state.partial = true
      state.diagnostics.add('budget_exhausted')
      throw new BudgetStop()
    }
    if (depth > state.budgets.maxDepth) {
      state.partial = true
      state.diagnostics.add('budget_exhausted')
      throw new BudgetStop()
    }
    const segment = remaining[0]!
    const rest = remaining.slice(1)
    const listing = listDir(absoluteDir, relativeDir, rules, state)
    if (segment === '**') {
      // Any-depth descent; prune-first stops at package leaves below.
      for (const [, childRelative] of listing.subdirs) {
        results.push(childRelative)
        const childAbsolute = join(root, childRelative)
        walk(childAbsolute, childRelative, ['**'], listing.ignoreRules, depth + 1)
      }
      return
    }
    const last = rest.length === 0
    if (segment.includes('*') || segment.includes('?')) {
      const matcher = new RegExp(
        `^${segment
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '\uE000')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')
          .replace(/\uE000/g, '.*')}$`
      )
      for (const [name, childRelative] of listing.subdirs) {
        if (!matcher.test(name)) continue
        if (last) results.push(childRelative)
        else walk(join(absoluteDir, name), childRelative, rest, listing.ignoreRules, depth + 1)
      }
      return
    }
    const childRelative = relativeDir === '' ? segment : `${relativeDir}/${segment}`
    if (!listing.subdirs.has(segment)) {
      if (last && !listing.files.has(segment)) {
        // A literal member that does not exist is a declaration error.
        results.push(`\uE000missing:${childRelative}`)
      }
      return
    }
    if (last) results.push(childRelative)
    else walk(join(absoluteDir, segment), childRelative, rest, listing.ignoreRules, depth + 1)
  }
  walk(root, '', segments, parentRules, 0)
  const dirs: string[] = []
  let missingLiteral = false
  for (const entry of results) {
    if (entry.startsWith('\uE000missing:')) {
      state.diagnostics.add(`missing_workspace_member:${entry.slice('\uE000missing:'.length)}`)
      missingLiteral = true
      continue
    }
    if (!dirs.includes(entry)) dirs.push(entry)
  }
  return { dirs, missingLiteral }
}

/**
 * Scan one authorized directory root for importable workspace packages.
 * The root itself must already be canonical and symlink-free (the roots
 * authority proves that before calling); nothing below it is followed
 * through a symlink.
 */
export function scanDirectoryRoot(input: {
  canonicalRoot: string
  budgets?: Partial<ScanBudgets>
  shouldCancel?: ScanShouldCancel
  now?: () => number
}): DirectoryScanResult {
  const budgets: ScanBudgets = { ...DEFAULT_SCAN_BUDGETS, ...input.budgets }
  const now = input.now ?? (() => Date.now())
  const state: WalkState = {
    budgets,
    examined: 0,
    entries: [],
    diagnostics: new Set<string>(),
    cancelled: false,
    deadline: now() + budgets.timeBudgetMs,
    ...(input.shouldCancel ? { shouldCancel: input.shouldCancel } : {}),
    partial: false,
  }
  const rootPresent = lstatSync(input.canonicalRoot, { throwIfNoEntry: false })
  if (!rootPresent || !rootPresent.isDirectory()) {
    return {
      entries: [],
      partial: true,
      diagnostics: ['root_unreadable'],
      examinedEntries: 0,
      cancelled: false,
    }
  }
  try {
    const rootListing = listDir(input.canonicalRoot, '', [], state)
    const declaration = readWorkspaceDeclaration(input.canonicalRoot, rootListing, state)
    if (declaration) {
      collectDeclaredMembers(input.canonicalRoot, rootListing, declaration, state)
    } else {
      walkForPackages(input.canonicalRoot, rootListing, state, 0, '')
    }
  } catch (error) {
    if (!(error instanceof BudgetStop) && !(error instanceof CancelledStop)) throw error
  }
  return {
    entries: state.entries,
    partial: state.partial,
    diagnostics: [...state.diagnostics],
    examinedEntries: state.examined,
    cancelled: state.cancelled,
  }
}

type WorkspaceDeclaration = {
  members: readonly string[]
  /** The manifest that declared the workspaces, for diagnostics. */
  source: string
  /** The workspace tool implies the member package manager (pnpm, uv). */
  managerHint?: ScanCandidate['packageManager']
}

function readWorkspaceDeclaration(
  root: string,
  listing: DirListing,
  state: WalkState
): WorkspaceDeclaration | undefined {
  const members: string[] = []
  let source: string | undefined
  let managerHint: ScanCandidate['packageManager'] | undefined
  if (listing.files.has('pnpm-workspace.yaml')) {
    const read = readManifest(join(root, 'pnpm-workspace.yaml'), state.budgets.maxManifestBytes)
    if ('error' in read) state.diagnostics.add(`malformed_manifest:pnpm-workspace.yaml`)
    else {
      const parsed = parsePnpmWorkspace(read.content)
      if (parsed.malformed || !parsed.members) {
        state.diagnostics.add('malformed_manifest:pnpm-workspace.yaml')
      } else {
        members.push(...parsed.members)
        source = source ?? 'pnpm-workspace.yaml'
        managerHint = managerHint ?? 'pnpm'
      }
    }
  }
  if (listing.files.has('package.json')) {
    const read = readManifest(join(root, 'package.json'), state.budgets.maxManifestBytes)
    if ('content' in read) {
      const info = parsePackageJsonManifest(read.content, listing.files, state)
      if (info.workspaces) {
        members.push(...info.workspaces)
        source = source ?? 'package.json'
      }
    }
  }
  if (listing.files.has('Cargo.toml')) {
    const read = readManifest(join(root, 'Cargo.toml'), state.budgets.maxManifestBytes)
    if ('content' in read) {
      const sections = parseTomlSections(read.content)
      const workspaceMembers = sections.get('workspace')?.members
      if (workspaceMembers) {
        members.push(...workspaceMembers)
        source = source ?? 'Cargo.toml'
      }
      if (sections.get('workspace')?.membersMalformed) {
        state.diagnostics.add('malformed_manifest:Cargo.toml')
      }
    }
  }
  if (listing.files.has('pyproject.toml')) {
    const read = readManifest(join(root, 'pyproject.toml'), state.budgets.maxManifestBytes)
    if ('content' in read) {
      const sections = parseTomlSections(read.content)
      const uvMembers = sections.get('tool.uv.workspace')?.members
      if (uvMembers) {
        members.push(...uvMembers)
        source = source ?? 'pyproject.toml'
        managerHint = managerHint ?? 'uv'
      }
      if (sections.get('tool.uv.workspace')?.membersMalformed) {
        state.diagnostics.add('malformed_manifest:pyproject.toml')
      }
    }
  }
  if (!source || members.length === 0) return undefined
  return { members, source, ...(managerHint ? { managerHint } : {}) }
}

function collectDeclaredMembers(
  root: string,
  rootListing: DirListing,
  declaration: WorkspaceDeclaration,
  state: WalkState
): void {
  // The root itself is a package when it carries its own manifest.
  const rootCandidate = manifestInfoForDir(root, '', rootListing.files, state)
  if (rootCandidate) pushCandidate(state, rootCandidate)
  for (const pattern of declaration.members) {
    // '**' patterns resolve through the pruned expansion; plain globs too.
    const { dirs } = expandMemberPattern(root, pattern, rootListing.ignoreRules, state)
    for (const relativeDir of dirs) {
      if (state.entries.length >= state.budgets.maxPackages) {
        state.partial = true
        state.diagnostics.add('budget_exhausted')
        throw new BudgetStop()
      }
      const absoluteDir = join(root, relativeDir)
      const listing = listDir(absoluteDir, relativeDir, rootListing.ignoreRules, state)
      const depth = relativeDir.split('/').length
      if (depth > state.budgets.maxDepth) {
        state.partial = true
        state.diagnostics.add('budget_exhausted')
        throw new BudgetStop()
      }
      const candidate = manifestInfoForDir(
        absoluteDir,
        relativeDir,
        listing.files,
        state,
        rootListing.files,
        declaration.managerHint
      )
      if (candidate) pushCandidate(state, candidate)
      else {
        // A declared member without any known manifest is still surfaced as
        // an unknown preview rather than silently dropped.
        pushCandidate(state, {
          name: basenameOf(relativeDir),
          relativeDir,
          manifestPath: `${relativeDir}/(none)`,
          packageManager: 'unknown',
          languages: [],
          suggestedScripts: [],
          diagnostics: ['no_manifest'],
        })
      }
    }
  }
}

/**
 * Prune-first descent for roots without a declared workspace: every directory
 * carrying a recognizable manifest is a candidate, and the walk never
 * descends into a discovered package.
 */
function walkForPackages(
  root: string,
  listing: DirListing,
  state: WalkState,
  depth: number,
  /**
   * The package directory relative to the scan root. It has to travel with the
   * recursion: without it every package in a multi-package tree reported
   * `relativeDir: ''` and `manifestPath: 'package.json'`, so the caller could
   * not tell two packages apart (or address either of them).
   */
  relativeDir: string,
  rootFiles: ReadonlySet<string> = listing.files
): void {
  if (state.entries.length >= state.budgets.maxPackages) {
    state.partial = true
    state.diagnostics.add('budget_exhausted')
    throw new BudgetStop()
  }
  if (depth > state.budgets.maxDepth) {
    state.partial = true
    state.diagnostics.add('budget_exhausted')
    return
  }
  const candidate = manifestInfoForDir(root, relativeDir, listing.files, state, rootFiles)
  if (candidate) {
    pushCandidate(state, candidate)
    return
  }
  for (const [name, childRelative] of listing.subdirs) {
    if (state.entries.length >= state.budgets.maxPackages) {
      state.partial = true
      state.diagnostics.add('budget_exhausted')
      throw new BudgetStop()
    }
    const childAbsolute = join(root, name)
    charge(state)
    const childListing = listDir(childAbsolute, childRelative, listing.ignoreRules, state)
    walkForPackages(childAbsolute, childListing, state, depth + 1, childRelative, rootFiles)
  }
}

function pushCandidate(state: WalkState, candidate: ScanCandidate): void {
  if (state.entries.length >= state.budgets.maxPackages) {
    state.partial = true
    state.diagnostics.add('budget_exhausted')
    throw new BudgetStop()
  }
  for (const diagnostic of candidate.diagnostics) {
    state.diagnostics.add(`${diagnostic}:${candidate.manifestPath}`)
  }
  state.entries.push(candidate)
}

/**
 * Fingerprint of the manifest/ignore facts that invalidate a cached scan:
 * identity of the root's workspace manifests plus the ignore file. Watchers
 * coalesce and hand this to the register; `force` bypasses the cache.
 */
export function rootScanFingerprint(canonicalRoot: string): string {
  const facts: string[] = []
  for (const name of [...ROOT_WORKSPACE_MANIFESTS, '.gitignore']) {
    const stats = statSync(join(canonicalRoot, name), { throwIfNoEntry: false })
    facts.push(name, stats ? `${stats.size}:${stats.mtimeMs}` : 'absent')
  }
  return facts.join('|')
}

export const SCAN_PACKAGE_MANIFESTS: readonly string[] = PACKAGE_MANIFESTS
