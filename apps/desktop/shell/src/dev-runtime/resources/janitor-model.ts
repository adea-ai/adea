// Machine-wide janitor model (owner follow-up #3): the pure half of the
// janitor — section roots, path-derived ids, display labels, worktree-list
// filtering, the bounded size walk, plan digests, and trash naming — over an
// injected filesystem seam, so the safety properties are testable without a
// real filesystem.
//
// Safety contract (spec "Machine-wide janitor"):
// - The scan universe is closed over the well-known junk roots plus git
//   worktrees discovered under the configured scan roots. Only first-level
//   entries are listed; symlinked entries are skipped, never followed.
// - Every disposal re-proves the item's on-disk identity (device + inode)
//   immediately before acting, and the default disposal is the platform Trash.
// - Sizes are computed with bounded budgets; an unmeasured item stays
//   unknown, never zero.
import { createHash } from 'node:crypto'

export type JanitorIdentity = Readonly<{ device: string; inode: string }>

/** The minimal filesystem surface the janitor reads; tests script it. */
export type JanitorFsEntry = Readonly<{
  isDirectory: boolean
  isFile: boolean
  isSymbolicLink: boolean
  identity: JanitorIdentity
  /** Preferred byte estimate: allocated blocks when reported, else size. */
  bytes: number
  mtimeMs: number
}>

export type JanitorFs = Readonly<{
  lstat(path: string): JanitorFsEntry | undefined
  readdir(path: string): readonly string[]
  rename(from: string, to: string): void
  removeRecursive(path: string): void
}>

export type JanitorSectionKind = 'derived_data' | 'cache' | 'logs' | 'trash' | 'worktree'

export type JanitorDisposal = 'trash' | 'trash_empty' | 'prune'

/** The closed scan universe: four well-known junk roots under the home
 * directory. The Trash root itself and the home are never items. */
export function janitorSectionRoots(
  home: string
): Readonly<Record<Exclude<JanitorSectionKind, 'worktree'>, string>> {
  return {
    derived_data: `${home}/Library/Developer/Xcode/DerivedData`,
    cache: `${home}/Library/Caches`,
    logs: `${home}/Library/Logs`,
    trash: `${home}/.Trash`,
  }
}

/** Stable, path-derived id: a compact sha256 of the canonical path. The host
 * binds authority through the plan, not the id, so a truncated digest is
 * enough; it stays deterministic across scans so the sheet can hold a
 * selection. */
export function janitorItemId(canonicalPath: string): string {
  return `jn-${createHash('sha256').update(canonicalPath).digest('hex').slice(0, 32)}`
}

/** Home-abbreviated display path; the absolute path never leaves the host. */
export function janitorPathLabel(home: string, absolutePath: string): string {
  if (absolutePath === home) return '~'
  if (absolutePath.startsWith(`${home}/`)) return `~${absolutePath.slice(home.length)}`
  return absolutePath
}

export type JanitorScanEntry = Readonly<{
  id: string
  section: JanitorSectionKind
  canonicalPath: string
  pathLabel: string
  label: string
  disposal: JanitorDisposal
  identity: JanitorIdentity
  /** Entry stat facts available at discovery time. */
  modifiedAt?: string
  isDirectory: boolean
  worktree?: Readonly<{ branchLabel?: string; prunableReason?: string; registered: false }>
}>

export type JanitorWorktreeInput = Readonly<{
  path: string
  branchRef?: string
  detached: boolean
  bare: boolean
  locked: boolean
  prunable?: string
}>

export type JanitorWorktreeFilterInput = Readonly<{
  /** `git worktree list --porcelain` entries for one scan root (a repository). */
  entries: readonly JanitorWorktreeInput[]
  /** The scan root itself — its primary checkout is never an item. */
  root: string
  /** Canonical roots Adea already registers; those keep their own lifecycle. */
  registeredRoots: readonly string[]
  home: string
}>

export type JanitorWorktreeCandidate = Readonly<{
  canonicalPath: string
  label: string
  pathLabel: string
  disposal: JanitorDisposal
  branchLabel?: string
  prunableReason?: string
}>

/** The worktree half of the closed scan universe: unregistered worktrees of
 * one repository root. The primary checkout and every Adea-registered root
 * are never candidates, and a locked worktree never is — the lock is the
 * user's own pin, and Git itself would refuse to prune it. A prunable entry
 * (Git says the directory is gone) is a prune candidate; a real directory is
 * a move-to-Trash candidate, with the host proving existence (and capturing
 * the identity the commit re-proves) before the item is listed. */
export function janitorWorktreeCandidates(
  input: JanitorWorktreeFilterInput
): readonly JanitorWorktreeCandidate[] {
  const registered = new Set(input.registeredRoots)
  const candidates: JanitorWorktreeCandidate[] = []
  for (const [index, entry] of input.entries.entries()) {
    if (entry.bare || entry.locked) continue
    const primary = index === 0
    if (primary || registered.has(entry.path)) continue
    const branchLabel = branchLabelOf(entry)
    if (entry.prunable === undefined) {
      // Git lists the worktree as healthy: a real directory the user may want
      // to reclaim. The host lists it only after lstat proves the directory,
      // so a stale registry race never surfaces a nonexistent path.
      candidates.push({
        canonicalPath: entry.path,
        label: branchLabel ?? basenameOf(entry.path),
        ...(branchLabel !== undefined ? { branchLabel } : {}),
        disposal: 'trash',
        pathLabel: janitorPathLabel(input.home, entry.path),
      })
      continue
    }
    candidates.push({
      canonicalPath: entry.path,
      label: branchLabel ?? basenameOf(entry.path),
      ...(branchLabel !== undefined ? { branchLabel } : {}),
      ...(entry.prunable !== undefined ? { prunableReason: entry.prunable } : {}),
      disposal: 'prune',
      pathLabel: janitorPathLabel(input.home, entry.path),
    })
  }
  return candidates
}

function branchLabelOf(entry: JanitorWorktreeInput): string | undefined {
  if (entry.branchRef) return entry.branchRef.replace(/^refs\/heads\//, '')
  if (entry.detached) return 'detached'
  return undefined
}

function basenameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index >= 0 ? path.slice(index + 1) : path
}

export type JanitorWorktreePorcelainEntry = Readonly<{
  path: string
  branchRef?: string
  detached: boolean
  bare: boolean
  locked: boolean
  prunable?: string
}>

/** Minimal `git worktree list --porcelain` field parser for the janitor:
 * attribute lines are matched exactly, so hostile path text can never become
 * an attribute. */
export function parseWorktreePorcelain(stdout: string): readonly JanitorWorktreePorcelainEntry[] {
  const entries: JanitorWorktreePorcelainEntry[] = []
  let current:
    | {
        path: string
        branchRef?: string
        detached: boolean
        bare: boolean
        locked: boolean
        prunable?: string
      }
    | undefined
  for (const line of stdout.split('\n')) {
    if (line.length === 0) {
      if (current) entries.push(current)
      current = undefined
      continue
    }
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = {
        path: line.slice('worktree '.length),
        detached: false,
        bare: false,
        locked: false,
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('branch ')) current.branchRef = line.slice('branch '.length)
    else if (line === 'detached') current.detached = true
    else if (line === 'bare') current.bare = true
    else if (line === 'locked') current.locked = true
    else if (line.startsWith('prunable ')) current.prunable = line.slice('prunable '.length)
  }
  if (current) entries.push(current)
  return entries
}

/** Bounded byte walk: no symlink follow, bounded depth, a shared deadline,
 * and per-walk entry budget. Returns measured bytes, `stale` when the budget
 * ran out (keeping any previous answer), and `unreadable` when the entry
 * itself cannot be proven. */
export function measureBytes(
  fs: JanitorFs,
  root: string,
  budget: Readonly<{ deadlineMs: number; maxEntries: number; maxDepth: number }>,
  now: () => number
):
  | { state: 'measured'; bytes: number }
  | { state: 'stale'; bytes: number | undefined }
  | { state: 'unreadable' } {
  const presented = fs.lstat(root)
  if (!presented || presented.isSymbolicLink) return { state: 'unreadable' }
  if (!presented.isDirectory) return { state: 'measured', bytes: presented.bytes }
  let total = 0
  let entries = 0
  const stack: Readonly<{ path: string; depth: number }>[] = [{ path: root, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop() as { path: string; depth: number }
    let names: readonly string[]
    try {
      names = fs.readdir(current.path)
    } catch {
      continue // An unreadable subdirectory contributes nothing.
    }
    for (const name of names) {
      entries += 1
      if (entries > budget.maxEntries || now() > budget.deadlineMs) {
        return { state: 'stale', bytes: undefined }
      }
      const child = fs.lstat(`${current.path}/${name}`)
      if (!child || child.isSymbolicLink) continue
      if (child.isDirectory) {
        total += child.bytes
        if (current.depth < budget.maxDepth) {
          stack.push({ path: `${current.path}/${name}`, depth: current.depth + 1 })
        }
      } else {
        total += child.bytes
      }
    }
  }
  return { state: 'measured', bytes: total }
}

/** Canonical plan digest (registry `sha256`): key order sorted so the same
 * facts always produce the same digest across plan and commit. */
export function janitorPlanDigest(
  facts: readonly Readonly<{ id: string; disposal: JanitorDisposal; identity: JanitorIdentity }>[],
  generation: number
): string {
  const sorted = facts.toSorted((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  )
  const canonical = JSON.stringify({
    generation,
    items: sorted.map((fact) => ({
      disposal: fact.disposal,
      id: fact.id,
      identity: { device: fact.identity.device, inode: fact.identity.inode },
    })),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** The Trash destination name: recognizable, and unique inside the Trash
 * without overwriting anything (`name`, `name-2`, `name-3`, …). */
export function trashDestinationName(existing: readonly string[], base: string): string {
  if (!existing.includes(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`
    if (!existing.includes(candidate)) return candidate
  }
}

/** Identity re-proof: the on-disk entry must still be the exact directory
 * (device + inode) the scan proved, and never a symlink. */
export function identityMatches(
  presented: JanitorFsEntry | undefined,
  expected: JanitorIdentity,
  requireDirectory: boolean
): boolean {
  if (!presented || presented.isSymbolicLink) return false
  if (requireDirectory && !presented.isDirectory) return false
  return (
    presented.identity.device === expected.device && presented.identity.inode === expected.inode
  )
}

/** ISO modified time from an entry stat; unprovable stays absent. */
export function modifiedAtOf(mtimeMs: number, now: () => number): string | undefined {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0 || mtimeMs > now()) return undefined
  return new Date(mtimeMs).toISOString()
}
