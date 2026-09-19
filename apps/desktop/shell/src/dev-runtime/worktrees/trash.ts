// Quarantine trash: managed deletion renames the checkout into a sibling
// owner-only trash root before any deletion, revalidates identity on both
// sides of the rename, and only ever deletes the proven trash identity.
//
// Why rename-then-delete: `git worktree remove` deletes a whole checkout
// (often multi-GB) synchronously; renaming the directory aside is a metadata
// operation and the recursive delete then runs deferred, with recovery.
//
// Hardening over the donor: the rename is never skipped in favor of an
// in-place delete (a rename failure fails the step), a symlinked or
// non-directory trash root is `dangerous_path` rather than a warning, every
// trash entry carries a provenance record so the sweep deletes only correctly
// named, identity-matching, proven-stale entries, and the sweep persists its
// continuation backlog so a page cap or crash resumes instead of abandoning
// entries beyond the first page.
//
// Portions substantially translated from Orca (https://github.com/stablyai/orca)
// `src/main/worktree-trash.ts`, pinned revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7, MIT License.
// Copyright (c) 2026 Stably AI, Inc.
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

import { nowIso } from '../authority'
import { WorktreeError } from './errors'
import { identityOfPath, isDangerousCleanupPath, sameIdentity } from './identity'

export const WORKTREE_TRASH_DIR_NAME = '.adea-worktree-trash'

// `<epoch-ms>-<nonce>`: the nonce keeps concurrent removals of same-named
// worktrees from colliding. The pattern is provenance: only entries this
// module generated are ever swept.
const TRASH_ENTRY_PATTERN = /^wt-\d+-[0-9a-f]{8}$/

/** Trash root for a worktree: a hidden sibling, so the rename always stays on
 *  one volume. */
export function worktreeTrashRoot(worktreePath: string): string {
  return join(dirname(worktreePath), WORKTREE_TRASH_DIR_NAME)
}

export function isTrashEntryName(entryName: string): boolean {
  return TRASH_ENTRY_PATTERN.test(entryName)
}

export type TrashRecord = Readonly<{
  worktreeId: string
  entryName: string
  identity: { device: string; inode: string }
  quarantinedAt: string
}>

function trashRecordPath(trashRoot: string, entryName: string): string {
  return join(trashRoot, `${entryName}.record.json`)
}

function readTrashRecord(trashRoot: string, entryName: string): TrashRecord | null {
  try {
    const parsed = JSON.parse(
      readFileSync(trashRecordPath(trashRoot, entryName), 'utf8')
    ) as TrashRecord | null
    if (!parsed || typeof parsed !== 'object' || !isTrashEntryName(parsed.entryName)) return null
    return parsed
  } catch {
    return null
  }
}

/** Revalidate canonical path, identity, and safety immediately before the
 *  rename, rename atomically into the sibling trash root, then revalidate the
 *  moved identity immediately after. Any mismatch restores the rename. */
export function quarantineWorktree(input: {
  worktreeId: string
  worktreePath: string
  repoPath: string
  expectedIdentity: { device: string; inode: string }
  clock?: () => Date
}): { trashRoot: string; trashPath: string; entryName: string } {
  const { worktreePath, repoPath } = input
  if (isDangerousCleanupPath(worktreePath, repoPath)) {
    throw new WorktreeError('dangerous_path', 'refusing to quarantine a dangerous path')
  }

  // Immediate pre-rename revalidation: same directory, no symlink spelling.
  const presented = lstatSync(worktreePath, { throwIfNoEntry: false })
  if (!presented) throw new WorktreeError('not_found', 'worktree path is missing before quarantine')
  if (presented.isSymbolicLink() || !presented.isDirectory()) {
    throw new WorktreeError('special_file_rejected', 'worktree path is no longer a real directory')
  }
  const canonical = realpathSync(worktreePath)
  const identity = identityOfPath(canonical)
  if (
    identity.device !== input.expectedIdentity.device ||
    identity.inode !== input.expectedIdentity.inode
  ) {
    throw new WorktreeError('identity_mismatch', 'worktree identity changed before quarantine')
  }

  const trashRoot = worktreeTrashRoot(canonical)
  mkdirSync(trashRoot, { recursive: true, mode: 0o700 })
  const trashRootStat = lstatSync(trashRoot)
  if (!trashRootStat.isDirectory() || trashRootStat.isSymbolicLink()) {
    throw new WorktreeError('dangerous_path', `refusing a non-directory worktree trash root`)
  }

  const entryName = `wt-${Date.now()}-${randomBytes(4).toString('hex')}`
  const trashPath = join(trashRoot, entryName)
  renameSync(canonical, trashPath)

  // Immediate post-rename revalidation: the moved directory must be the same
  // directory (same device + inode) that was proven above.
  const moved = lstatSync(trashPath, { throwIfNoEntry: false })
  if (!moved || !moved.isDirectory()) {
    // The rename did not land as proven; surface recovery instead of guessing.
    throw new WorktreeError(
      'recovery_required',
      'quarantined entry is missing immediately after rename'
    )
  }
  const movedIdentity = identityOfPath(trashPath)
  if (!sameIdentity(movedIdentity, identity)) {
    throw new WorktreeError(
      'recovery_required',
      'quarantined entry changed identity across the rename'
    )
  }

  writeFileSync(
    trashRecordPath(trashRoot, entryName),
    JSON.stringify({
      worktreeId: input.worktreeId,
      entryName,
      identity: { device: identity.device, inode: identity.inode },
      quarantinedAt: nowIso(input.clock),
    } satisfies TrashRecord),
    { mode: 0o600 }
  )
  return { trashRoot, trashPath, entryName }
}

/** Undo a quarantine so a failed registration cleanup leaves the worktree
 *  exactly as Git registered it. Returns false (never throws) when the
 *  original path cannot be restored. */
export function restoreWorktreeFromTrash(trashPath: string, worktreePath: string): boolean {
  try {
    renameSync(trashPath, worktreePath)
    return true
  } catch {
    return false
  }
}

/** Delete one quarantined entry after proving, immediately before the delete,
 *  that the entry still matches the identity recorded at quarantine time. */
export function deleteQuarantinedWorktree(input: {
  trashRoot: string
  entryName: string
  record?: TrashRecord
}): { deleted: boolean } {
  if (!isTrashEntryName(input.entryName)) {
    throw new WorktreeError('dangerous_path', 'refusing to delete a non-trash entry name')
  }
  const trashPath = join(input.trashRoot, input.entryName)
  const record = input.record ?? readTrashRecord(input.trashRoot, input.entryName)
  if (!record) {
    throw new WorktreeError('ownership_unproven', 'quarantined entry has no provenance record')
  }
  const presented = lstatSync(trashPath, { throwIfNoEntry: false })
  if (!presented) {
    // Already gone: deleting is idempotent.
    try {
      unlinkSync(trashRecordPath(input.trashRoot, input.entryName))
    } catch {
      // Record already gone too.
    }
    return { deleted: false }
  }
  if (presented.isSymbolicLink() || !presented.isDirectory()) {
    throw new WorktreeError('dangerous_path', 'quarantined entry is not the proven directory')
  }
  const identity = identityOfPath(trashPath)
  if (identity.device !== record.identity.device || identity.inode !== record.identity.inode) {
    throw new WorktreeError(
      'identity_mismatch',
      'quarantined entry changed identity before deletion'
    )
  }
  rmSync(trashPath, { recursive: true, force: false })
  try {
    unlinkSync(trashRecordPath(input.trashRoot, input.entryName))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { deleted: true }
}

export type SweepBacklog = Readonly<{
  roots: ReadonlyArray<string>
  entries: ReadonlyArray<Readonly<{ root: string; entryName: string }>>
  cursor: number
  updatedAt: string
}>

export type SweepPageResult = Readonly<{
  removed: number
  failed: number
  remaining: number
  done: boolean
}>

export function createTrashSweeper(options: {
  stateFile: string
  staleAfterMs?: number
  clock?: () => Date
}) {
  const { stateFile } = options
  const staleAfterMs = options.staleAfterMs ?? 60 * 60 * 1000
  const clock = options.clock ?? (() => new Date())

  function loadBacklog(): SweepBacklog | null {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as SweepBacklog | null
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return null
      return parsed
    } catch {
      return null
    }
  }

  function saveBacklog(backlog: SweepBacklog | null): void {
    if (backlog === null) {
      try {
        unlinkSync(stateFile)
      } catch {
        // Already gone.
      }
      return
    }
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 })
    writeFileSync(stateFile, JSON.stringify(backlog), { mode: 0o600 })
  }

  /** Enumerate provenance-recorded trash entries across roots into a persisted
   *  backlog. Existing in-progress backlogs are preserved (and extended), so
   *  a restart never abandons entries beyond the first page. */
  function beginSweep(trashRoots: ReadonlyArray<string>): SweepBacklog {
    const prior = loadBacklog()
    const seen = new Set((prior?.entries ?? []).map((entry) => `${entry.root}:${entry.entryName}`))
    const entries: Array<{ root: string; entryName: string }> = [...(prior?.entries ?? [])]
    for (const root of trashRoots) {
      const resolved = resolve(root)
      const stat = lstatSync(resolved, { throwIfNoEntry: false })
      // A missing, symlinked, or non-directory trash root has nothing to sweep.
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue
      let names: string[] = []
      try {
        names = readdirSync(resolved)
      } catch {
        continue
      }
      for (const name of names) {
        if (!isTrashEntryName(name)) continue
        const key = `${resolved}:${name}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({ root: resolved, entryName: name })
      }
    }
    const backlog: SweepBacklog = {
      roots: [...trashRoots],
      entries,
      cursor: prior?.cursor ?? 0,
      updatedAt: nowIso(clock),
    }
    saveBacklog(backlog)
    return backlog
  }

  /** Process at most `maxEntries` backlog entries. Each entry is deleted only
   *  when it is correctly named, provenance-matched, identity-matched, and
   *  proven stale; anything else is kept and reported. The cursor is
   *  persisted after every page, so a crash resumes where it stopped. */
  function sweepPage(maxEntries: number): SweepPageResult {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new WorktreeError('invalid_state', 'sweep page size must be a positive integer')
    }
    const backlog = loadBacklog()
    if (!backlog) return { removed: 0, failed: 0, remaining: 0, done: true }
    const entries = [...backlog.entries]
    let cursor = backlog.cursor
    let removed = 0
    const skipped: Array<{ root: string; entryName: string }> = []
    const at = clock().getTime()
    const end = Math.min(cursor + maxEntries, entries.length)
    while (cursor < end) {
      const entry = entries[cursor]
      cursor += 1
      try {
        const record = readTrashRecord(entry.root, entry.entryName)
        const quarantinedAt = record ? new Date(record.quarantinedAt).getTime() : NaN
        if (!record || Number.isNaN(quarantinedAt) || at - quarantinedAt < staleAfterMs) {
          // Not ours, or not yet proven stale: requeue, never abandon.
          skipped.push(entry)
          continue
        }
        deleteQuarantinedWorktree({ trashRoot: entry.root, entryName: entry.entryName, record })
        removed += 1
      } catch {
        skipped.push(entry)
      }
    }
    const keptTail = entries.length - cursor
    if (keptTail > 0) {
      saveBacklog({ ...backlog, cursor, updatedAt: nowIso(clock) })
      return { removed, failed: skipped.length, remaining: keptTail + skipped.length, done: false }
    }
    if (skipped.length > 0) {
      // Nothing tail remains; requeue what the page declined so a later sweep
      // (once stale) drains it instead of forgetting it.
      saveBacklog({ roots: backlog.roots, entries: skipped, cursor: 0, updatedAt: nowIso(clock) })
      return { removed, failed: skipped.length, remaining: skipped.length, done: false }
    }
    saveBacklog(null)
    return { removed, failed: 0, remaining: 0, done: true }
  }

  function pendingCount(): number {
    const backlog = loadBacklog()
    if (!backlog) return 0
    return Math.max(0, backlog.entries.length - backlog.cursor)
  }

  return Object.freeze({ beginSweep, sweepPage, pendingCount, loadBacklog })
}
