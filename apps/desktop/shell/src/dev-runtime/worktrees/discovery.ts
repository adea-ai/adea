// Worktree discovery: `git worktree list --porcelain` on demand and when the
// git common-dir admin fingerprint changes — never a polling loop. External
// worktrees are adoptable only after canonical path/gitdir validation.
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { runGitChecked } from './git-run'
import { WorktreeError } from './errors'
import { directoryIdentity, proveWorktreeRegistration } from './identity'

export type WorktreeListEntry = Readonly<{
  path: string
  head?: string
  branchRef?: string
  detached: boolean
  bare: boolean
  locked: boolean
  prunable?: string
}>

/** `git worktree list --porcelain` parser. Field values are taken verbatim
 *  from git; attribute lines are matched exactly, so hostile path text cannot
 *  become an attribute. */
export function parseWorktreeList(stdout: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = []
  let current: {
    path: string
    head?: string
    branchRef?: string
    detached: boolean
    bare: boolean
    locked: boolean
    prunable?: string
  } | null = null
  for (const line of stdout.split('\n')) {
    if (line.length === 0) {
      if (current) entries.push(current)
      current = null
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
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) current.branchRef = line.slice('branch '.length)
    else if (line === 'detached') current.detached = true
    else if (line === 'bare') current.bare = true
    else if (line === 'locked') current.locked = true
    else if (line.startsWith('locked ')) current.locked = true
    else if (line.startsWith('prunable ')) current.prunable = line.slice('prunable '.length)
  }
  if (current) entries.push(current)
  return entries
}

/** Discover the repo's registered worktrees (primary first). One git child;
 *  callers gate this behind the admin fingerprint so it never becomes a
 *  polling storm. */
export async function discoverWorktrees(repoPath: string): Promise<WorktreeListEntry[]> {
  const result = await runGitChecked(['worktree', 'list', '--porcelain'], { cwd: repoPath })
  return parseWorktreeList(result.stdout).map((entry) => ({
    ...entry,
    path: realpathSync(entry.path),
  }))
}

/** Adoption proof for an externally created worktree: it must be a real
 *  directory, carry a valid gitdir backlink into the repo's own common dir,
 *  and must not be the repo's primary checkout. `repoRoot` is the repository
 *  working-tree root. Returns the proven identity for the adopted record. */
export async function proveExternalWorktree(input: {
  worktreePath: string
  repoRoot: string
}): Promise<{
  canonicalRoot: string
  gitDir: string
  identity: ReturnType<typeof directoryIdentity>['identity']
}> {
  const { path, identity } = directoryIdentity(input.worktreePath)
  const canonicalRepoRoot = realpathSync(input.repoRoot)
  if (path === canonicalRepoRoot) {
    // The primary checkout is a registration, not an adoption.
    throw new WorktreeError(
      'invalid_state',
      'the primary checkout is not adoptable as an external worktree'
    )
  }
  const proof = await proveWorktreeRegistration(path)
  if (!proof) {
    throw new WorktreeError(
      'gitdir_unproven',
      'external worktree gitdir backlink could not be proven'
    )
  }
  if (realpathSync(proof.commonDir) !== realpathSync(join(canonicalRepoRoot, '.git'))) {
    throw new WorktreeError(
      'gitdir_unproven',
      'external worktree belongs to a different repository'
    )
  }
  return { canonicalRoot: path, gitDir: proof.gitDir, identity }
}

/** The `.git` admin entry name Git assigned to a linked worktree (stable,
 *  path-derived; used to verify unregistration after prune). */
export async function worktreeAdminEntryName(worktreePath: string): Promise<string | null> {
  const proof = await proveWorktreeRegistration(worktreePath)
  if (!proof) return null
  return proof.gitDir.split('/').pop() ?? null
}

export function adminEntryExists(repoCommonDir: string, entryName: string): boolean {
  return (
    lstatSync(join(repoCommonDir, 'worktrees', entryName), { throwIfNoEntry: false }) !== undefined
  )
}
