// Managed bare clones for remote-only projects (ADR 0011, PR 15).
//
// A remote-only project has no user checkout: `dev.project.clone` places a
// hidden `--bare` clone under an Adea-managed, owner-only app-data root and
// its worktrees under a second owner-only root. Neither root is a user path
// and neither is ever covered by a root bookmark. Bare repositories are
// refused everywhere else; this module is the ONE proof that admits one:
//
//   - the managed root is a real, owner-only (0700, current uid) directory
//     reached from the data dir without a symlinked component;
//   - the repository directory is a direct child named `<repoId>.git`;
//   - it is a real directory carrying a regular `HEAD` file, `objects/` and
//     `refs/` directories, a regular `config`, and `core.bare=true`;
//   - its replacement-proof file identity (device + inode) matches the
//     registry record.
//
// Nothing here follows a client path: every location is derived from the
// data dir and an opaque repository id.
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { WorktreeError } from '../worktrees/errors'
import { runGit } from '../worktrees/git-run'
import { identityOfPath, sameIdentity, type FileIdentityValue } from '../worktrees/identity'

/** `<dataDir>/dev-runtime/managed-repos/<repoId>.git` holds each bare clone. */
export const MANAGED_REPOS_DIR = join('dev-runtime', 'managed-repos')
/** `<dataDir>/dev-runtime/managed-worktrees/<repoId>/<name>` holds its worktrees. */
export const MANAGED_WORKTREES_DIR = join('dev-runtime', 'managed-worktrees')

/** Limits registry: one clone may not exceed these budgets. */
export const MANAGED_CLONE_TIMEOUT_MS = 10 * 60_000
export const MANAGED_CLONE_MAX_BYTES = 4 * 1024 * 1024 * 1024
/** The size watchdog's sampling interval while a clone runs. */
export const MANAGED_CLONE_SIZE_POLL_MS = 500
/** Directory entries one size sample may visit before it reports over-budget. */
export const MANAGED_CLONE_MAX_ENTRIES = 1_000_000

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MANAGED_REPO_DIR_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.git$/
const GIT_READ_TIMEOUT_MS = 10_000

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

/** Prove one directory is real (never a symlink) and owner-only. */
function proveOwnerOnly(path: string, label: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) throw new WorktreeError('not_found', `${label} is missing`)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new WorktreeError('dangerous_path', `${label} must be a real directory`)
  const uid = currentUid()
  if (uid !== undefined && stat.uid !== uid)
    throw new WorktreeError('dangerous_path', `${label} is not owned by the current user`)
  if ((stat.mode & 0o077) !== 0)
    throw new WorktreeError('dangerous_path', `${label} must be owner-only`)
}

/** Walk `relative` below the data dir component by component: each
 *  component must be a real directory (never a symlink). With `create`,
 *  missing components are created owner-only. Returns the canonical path. */
function managedDir(dataDir: string, relative: string, create: boolean): string {
  const base = realpathSync(dataDir)
  let current = base
  for (const part of relative.split(sep).filter((segment) => segment.length > 0)) {
    current = join(current, part)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (!stat) {
      if (!create) throw new WorktreeError('not_found', 'the managed root is missing')
      mkdirSync(current, { mode: 0o700 })
      continue
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new WorktreeError('dangerous_path', 'a managed root component is not a real directory')
  }
  proveOwnerOnly(current, 'the managed root')
  return current
}

/** The canonical, owner-only managed bare-clone root (created on demand). */
export function ensureManagedReposRoot(dataDir: string): string {
  return managedDir(dataDir, MANAGED_REPOS_DIR, true)
}

/** The canonical managed bare-clone root, proven but never created. */
export function provenManagedReposRoot(dataDir: string): string {
  return managedDir(dataDir, MANAGED_REPOS_DIR, false)
}

export function requireRepoId(repoId: string): void {
  if (!UUID_PATTERN.test(repoId))
    throw new WorktreeError('identity_mismatch', 'managed repository id must be a lowercase UUID')
}

/** The bare clone directory for one repository id under a proven root. */
export function managedClonePath(managedRoot: string, repoId: string): string {
  requireRepoId(repoId)
  return join(managedRoot, `${repoId}.git`)
}

/** The owner-only worktree base for one managed repository (created on
 *  demand): `managed-worktrees/<repoId>`. There is no user bookmark above a
 *  managed clone, so this is the only base a managed worktree may use. */
export function ensureManagedWorktreeBase(dataDir: string, repoId: string): string {
  requireRepoId(repoId)
  return managedDir(dataDir, join(MANAGED_WORKTREES_DIR, repoId), true)
}

/**
 * The child environment for every network git child of a managed clone
 * (clone, its fetch, and later base fetches). Nothing may prompt: git's own
 * terminal prompt is off, askpass helpers are disabled, and SSH runs in
 * batch mode with strict host-key checking, so an unknown host key, a
 * password, or a passphrase prompt fails immediately instead of waiting out
 * the clone budget. `SSH_AUTH_SOCK` (a socket path, not key material) passes
 * through so agent-held keys still authenticate.
 */
export function nonInteractiveTransportEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_VARIANT: 'ssh',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=30',
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
  }
}

/** Structural containment: `path` is the managed root itself or below it. */
export function isWithin(root: string, path: string): boolean {
  const resolved = resolve(path)
  return resolved === root || resolved.startsWith(root + sep)
}

/**
 * The managed bare-repository proof. Returns the proven identity; throws a
 * typed refusal for anything else — a path outside the managed root, a
 * symlinked or non-bare directory, or a replaced directory whose identity no
 * longer matches the record.
 */
export async function proveManagedBareRepo(input: {
  dataDir: string
  canonicalRoot: string
  repoId?: string
  expectedIdentity?: FileIdentityValue
  git?: typeof runGit
}): Promise<FileIdentityValue> {
  const git = input.git ?? runGit
  const root = provenManagedReposRoot(input.dataDir)
  const path = input.canonicalRoot
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
    throw new WorktreeError('path_escape', 'managed repository path is malformed')
  if (resolve(path) !== path || dirname(path) !== root)
    throw new WorktreeError('unauthorized_root', 'managed repository is outside the managed root')
  const name = basename(path)
  if (!MANAGED_REPO_DIR_PATTERN.test(name))
    throw new WorktreeError('unauthorized_root', 'managed repository name is not a managed clone')
  if (input.repoId !== undefined && name !== `${input.repoId}.git`)
    throw new WorktreeError('identity_mismatch', 'managed repository does not belong to this id')
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) throw new WorktreeError('not_found', 'managed repository is missing on disk')
  if (stat.isSymbolicLink())
    throw new WorktreeError('symlink_rejected', 'managed repository must not be a symlink')
  if (!stat.isDirectory())
    throw new WorktreeError('special_file_rejected', 'managed repository must be a directory')
  if (realpathSync(path) !== path)
    throw new WorktreeError('path_escape', 'managed repository path is not canonical')
  proveOwnerOnly(path, 'the managed repository')
  proveBareLayout(path)
  const bare = await git(
    ['config', '--file', join(path, 'config'), '--bool', '--get', 'core.bare'],
    {
      cwd: root,
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxOutputBytes: 4096,
    }
  ).catch(() => undefined)
  if (bare?.exitCode !== 0 || bare.stdout.trim() !== 'true')
    throw new WorktreeError('not_git_repo', 'managed repository is not a bare repository')
  const identity = identityOfPath(path)
  if (input.expectedIdentity !== undefined && !sameIdentity(identity, input.expectedIdentity))
    throw new WorktreeError('identity_mismatch', 'managed repository identity changed')
  return identity
}

/** The structural bare layout: regular HEAD/config files, real objects/refs
 *  directories, and no `.git` entry (a working tree is never bare). */
export function proveBareLayout(path: string): void {
  const entry = (name: string) => lstatSync(join(path, name), { throwIfNoEntry: false })
  const head = entry('HEAD')
  const config = entry('config')
  const objects = entry('objects')
  const refs = entry('refs')
  if (
    !head?.isFile() ||
    !config?.isFile() ||
    !objects?.isDirectory() ||
    objects.isSymbolicLink() ||
    !refs?.isDirectory() ||
    refs.isSymbolicLink() ||
    entry('.git') !== undefined
  )
    throw new WorktreeError('not_git_repo', 'managed repository does not have a bare layout')
}

/** Bounded disk usage of one directory tree (no symlink is followed). Returns
 *  `Infinity` once the entry budget is spent so the caller refuses rather
 *  than under-counting. */
export function directoryBytes(path: string, maxEntries = MANAGED_CLONE_MAX_ENTRIES): number {
  let total = 0
  let visited = 0
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(current)
    } catch {
      continue
    }
    for (const name of names) {
      visited += 1
      if (visited > maxEntries) return Number.POSITIVE_INFINITY
      const child = join(current, name)
      const stat = lstatSync(child, { throwIfNoEntry: false })
      if (!stat) continue
      if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(child)
      else total += stat.size
    }
  }
  return total
}
