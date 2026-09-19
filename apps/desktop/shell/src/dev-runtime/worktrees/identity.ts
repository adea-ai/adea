// Worktree identity, git-administration fingerprints, and gitdir backlink
// proofs.
//
// The fingerprint is a cheap, subprocess-free summary of a repo's Git worktree
// administrative state. Equal fingerprints mean `git worktree list --porcelain`
// would report the same rows, so a caller can extend a scan cache instead of
// spawning Git. `null` means "cannot prove unchanged" (not a Git repo,
// unreadable layout, permission error) and callers must fall back to a real
// scan. Per adea#490 the per-worktree probes run with bounded parallelism; a
// repo with hundreds of worktrees must not queue its whole admin dir onto the
// fs threadpool at once.
//
// Portions substantially translated from Orca (https://github.com/stablyai/orca)
// `src/main/runtime/repo-worktree-admin-fingerprint.ts`,
// `src/main/worktree-removal-safety.ts`, and
// `src/main/worktree-orphan-gitdir-proof.ts`, pinned revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7, MIT License.
// Copyright (c) 2026 Stably AI, Inc.
import { lstatSync, realpathSync } from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'

import { mapWithConcurrency } from './concurrency'
import { WorktreeError } from './errors'

const { readFile, readdir, stat } = fsPromises

export type FileIdentityValue = Readonly<{
  device?: string
  inode?: string
  birthtimeNs?: string
  mtimeNs: string
  size: string
}>

// NUL can appear in neither a path nor a Git ref, so field boundaries stay unambiguous.
const FIELD_SEPARATOR = '\u0000'
const MISSING = '-'
const LINKED_WORKTREE_PROBE_CONCURRENCY = 8

export function identityOfPath(absolutePath: string): FileIdentityValue {
  const stats = lstatSync(absolutePath, { bigint: true, throwIfNoEntry: false })
  if (!stats) throw new WorktreeError('not_found', `path does not exist: kept private`)
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs),
    mtimeNs: String(stats.mtimeNs),
    size: String(stats.size),
  }
}

/** Stable identity comparison: only the replacement-proof fields, never the
 *  mutable directory metadata (mtime/size change with content). */
export function sameIdentity(a: FileIdentityValue, b: FileIdentityValue): boolean {
  return a.device === b.device && a.inode === b.inode
}

/** Strict content-freshness comparison for regular files: an in-place rewrite
 *  keeps the inode, so mtime and size must join the check. */
export function sameFileIdentityStrict(a: FileIdentityValue, b: FileIdentityValue): boolean {
  return (
    sameIdentity(a, b) &&
    a.mtimeNs === b.mtimeNs &&
    a.size === b.size &&
    a.birthtimeNs === b.birthtimeNs
  )
}

export function canonicalizePath(absolutePath: string): string {
  return realpathSync(absolutePath)
}

/** The worktree root must exist as a real directory (no symlinked spelling) or
 *  the identity is unprovable. */
export function directoryIdentity(absolutePath: string): {
  path: string
  identity: FileIdentityValue
} {
  const presented = lstatSync(absolutePath, { throwIfNoEntry: false })
  if (!presented) throw new WorktreeError('not_found', 'worktree path is missing on disk')
  if (presented.isSymbolicLink()) {
    throw new WorktreeError('symlink_rejected', 'worktree path must not be a symlink')
  }
  if (!presented.isDirectory()) {
    throw new WorktreeError('special_file_rejected', 'worktree path must be a directory')
  }
  const canonical = realpathSync(absolutePath)
  return { path: canonical, identity: identityOfPath(canonical) }
}

function containsPath(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath)
  // Why: `..name` is a valid child name; only `..` and `../...` escape.
  return (
    relativePath === '' ||
    (!!relativePath &&
      relativePath !== '..' &&
      !relativePath.startsWith('../') &&
      !isAbsolute(relativePath))
  )
}

/** Refuse paths whose deletion can never be a routine worktree cleanup: empty,
 *  the repo/primary checkout itself, a filesystem root, an ancestor of the repo
 *  or the home directory, or a well-known home shape. */
export function isDangerousCleanupPath(worktreePath: string, repoPath: string): boolean {
  if (!worktreePath.trim()) {
    return true
  }

  const resolvedWorktreePath = resolve(worktreePath)
  const resolvedRepoPath = resolve(repoPath)
  if (resolvedWorktreePath === resolvedRepoPath) {
    return true
  }

  const rootPath = parse(resolvedWorktreePath).root
  if (resolvedWorktreePath === rootPath) {
    return true
  }

  if (containsPath(resolvedWorktreePath, resolvedRepoPath)) {
    return true
  }

  const homePath = homedir()
  if (!!homePath && containsPath(resolvedWorktreePath, resolve(homePath))) {
    return true
  }

  return (
    resolvedWorktreePath === '/home' ||
    resolvedWorktreePath === '/root' ||
    /^\/home\/[^/]+$/.test(resolvedWorktreePath) ||
    /^\/Users\/[^/]+$/.test(resolvedWorktreePath)
  )
}

// --- gitdir backlink proof -------------------------------------------------

export type GitDirProof = Readonly<{
  /** The worktree's private git admin directory inside the repo common dir. */
  gitDir: string
  /** The shared common dir all worktrees of the repo register under. */
  commonDir: string
}>

function readTrimmed(text: string): string | null {
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function readTrimmedFile(filePath: string): Promise<string | null> {
  try {
    return readTrimmed(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (isMissingEntryError(error)) return null
    throw error
  }
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Parse the `gitdir: <path>` pointer file a linked worktree carries. A plain
 *  directory `.git` is the primary checkout and proves nothing here. */
export async function readLinkedGitDir(worktreePath: string): Promise<string | null> {
  const dotGit = lstatSync(join(worktreePath, '.git'), { throwIfNoEntry: false })
  if (!dotGit || !dotGit.isFile()) return null
  const contents = await readTrimmedFile(join(worktreePath, '.git'))
  const match = contents?.match(/^gitdir:(?:  | )(.+?)$/m) ?? contents?.match(/^gitdir:\s*(.+?)$/m)
  return match ? resolve(worktreePath, match[1]) : null
}

/** Prove the checkout is still the registered worktree it claims to be:
 *  the private admin dir exists, carries a commondir backlink, and its own
 *  `gitdir` file names this checkout's `.git`. Returns null when any link in
 *  the chain is missing (orphaned/unproven), never guessing. */
export async function proveWorktreeRegistration(worktreePath: string): Promise<GitDirProof | null> {
  // Canonicalize the presented path first: git records absolute, resolved
  // spellings in the backlink files (macOS `/var` → `/private/var`).
  let canonical: string
  try {
    canonical = realpathSync(worktreePath)
  } catch {
    return null
  }
  const gitDir = await readLinkedGitDir(canonical)
  if (!gitDir) return null
  const commondir = await readTrimmedFile(join(gitDir, 'commondir'))
  if (!commondir) return null
  const commonDir = resolve(gitDir, commondir)
  const adminGitDir = await readTrimmedFile(join(gitDir, 'gitdir'))
  if (!adminGitDir) return null
  // The admin `gitdir` file must name exactly this checkout's `.git` pointer.
  let namedCheckout: string
  try {
    namedCheckout = resolve(dirname(adminGitDir), realpathSync(dirname(adminGitDir)), '.git')
  } catch {
    return null
  }
  if (namedCheckout !== resolve(canonical, '.git')) return null
  return { gitDir, commonDir }
}

// --- admin fingerprint -----------------------------------------------------

/**
 * Identify the commit `git worktree list` would print for one checkout: the
 * HEAD line itself plus, when HEAD is a symref, the tip it names. Reading the
 * tip is what makes a plain commit visible — committing rewrites
 * `refs/heads/<branch>` and leaves HEAD untouched.
 */
async function readHeadStamp(commonDir: string, headDir: string): Promise<string> {
  const head = await readTrimmedFile(join(headDir, 'HEAD'))
  if (!head) {
    return MISSING
  }
  const refName = head.match(/^ref:\s*(.+?)\s*$/)?.[1]
  if (!refName || !isSafeRefName(refName)) {
    // Detached HEAD already holds the object id, and an unrecognized HEAD is covered by its own text.
    return head
  }
  // Per-worktree refs (`refs/bisect`, `refs/worktree`) live beside the checkout; branches are shared.
  const tip =
    (await readTrimmedFile(join(headDir, refName))) ??
    (await readTrimmedFile(join(commonDir, refName)))
  return [head, tip ?? MISSING].join(FIELD_SEPARATOR)
}

/** Keep a hand-edited HEAD from steering the probe outside the repo's ref store. */
function isSafeRefName(refName: string): boolean {
  const segments = refName.split(/[\\/]/)
  return (
    segments[0] === 'refs' &&
    segments.length > 1 &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..') &&
    !isAbsolute(refName)
  )
}

async function readLinkedWorktreeNames(adminDir: string): Promise<string[]> {
  try {
    const entries = await readdir(adminDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted()
  } catch (err) {
    // A repo with no linked worktrees has no admin dir at all; anything else is a real read failure.
    if (isMissingEntryError(err)) {
      return []
    }
    throw err
  }
}

async function readLinkedWorktreeStamp(
  commonDir: string,
  adminDir: string,
  name: string
): Promise<string> {
  const entryDir = join(adminDir, name)
  // `gitdir` holds "<worktree>/.git"; its contents follow `git worktree move` and `git worktree repair`.
  const gitdirTarget = await readTrimmedFile(join(entryDir, 'gitdir'))
  const [head, locked, worktreeExists] = await Promise.all([
    readHeadStamp(commonDir, entryDir),
    readExistenceStamp(join(entryDir, 'locked')),
    // Deleting a worktree directory outside the app flips its `prunable` row without touching the admin dir.
    gitdirTarget ? readExistenceStamp(dirname(gitdirTarget)) : Promise.resolve(MISSING),
  ])
  return [name, gitdirTarget ?? MISSING, head, locked, worktreeExists].join(FIELD_SEPARATOR)
}

async function readFileStamp(filePath: string): Promise<string> {
  try {
    const stats = await stat(filePath)
    return `${stats.mtimeMs}:${stats.size}`
  } catch (err) {
    if (isMissingEntryError(err)) {
      return MISSING
    }
    throw err
  }
}

async function readExistenceStamp(targetPath: string): Promise<string> {
  try {
    await stat(targetPath)
    return 'y'
  } catch (err) {
    if (isMissingEntryError(err)) {
      return 'n'
    }
    throw err
  }
}

async function resolveGitDir(repoPath: string): Promise<string | null> {
  const dotGitPath = join(repoPath, '.git')
  const dotGitStats = lstatSync(dotGitPath, { throwIfNoEntry: false })
  if (!dotGitStats) {
    // Bare repo, or a repo path that already is a gitdir.
    return (await readExistenceStamp(join(repoPath, 'HEAD'))) === 'y' ? repoPath : null
  }
  if (dotGitStats.isDirectory()) {
    return dotGitPath
  }
  if (!dotGitStats.isFile()) {
    return null
  }
  const contents = await readTrimmedFile(dotGitPath)
  const match = contents?.match(/^gitdir:\s*(.+?)$/m)
  return match ? resolve(repoPath, match[1]) : null
}

async function resolveGitCommonDir(repoPath: string): Promise<string | null> {
  const gitDir = await resolveGitDir(repoPath)
  if (!gitDir) {
    return null
  }
  // A linked worktree's gitdir points at the shared admin root through `commondir`.
  const commonDir = await readTrimmedFile(join(gitDir, 'commondir'))
  return commonDir ? resolve(gitDir, commonDir) : gitDir
}

/**
 * Cheap, subprocess-free summary of a local repo's Git worktree administrative
 * state. Equal fingerprints mean `git worktree list --porcelain` would report
 * the same rows. `null` means "cannot prove unchanged".
 *
 * Not covered: sparse-checkout pattern edits, and a tip moved through a ref
 * store this cannot read exactly (packed refs, the reftable backend), which
 * fall back to a coarser mtime + size stamp. Callers bound both with a
 * periodic unconditional rescan.
 */
export async function readRepoWorktreeAdminFingerprint(repoPath: string): Promise<string | null> {
  try {
    const commonDir = await resolveGitCommonDir(repoPath)
    if (!commonDir) {
      return null
    }
    const adminDir = join(commonDir, 'worktrees')
    const names = await readLinkedWorktreeNames(adminDir)
    const [mainHead, mainExists, packedRefs, reftable] = await Promise.all([
      readHeadStamp(commonDir, commonDir),
      readExistenceStamp(repoPath),
      // A tip whose loose ref file was packed away still moves these.
      readFileStamp(join(commonDir, 'packed-refs')),
      readFileStamp(join(commonDir, 'reftable')),
    ])
    const linked = await mapWithConcurrency(
      names,
      LINKED_WORKTREE_PROBE_CONCURRENCY,
      async (name) => await readLinkedWorktreeStamp(commonDir, adminDir, name)
    )
    return [mainHead, mainExists, packedRefs, reftable, String(names.length), ...linked].join(
      FIELD_SEPARATOR
    )
  } catch {
    return null
  }
}
