// Bounded `.worktreeinclude` planning and application.
//
// The plan derives candidates from git (never a directory walk), applies hard
// count/byte/type limits, refuses symlinks, special files, destination
// collisions, tracked-file overwrites, path escapes, and source/destination
// identity changes, and reports every candidate. Application is plan/commit:
// the caller supplies the plan digest, and every copy revalidates identities
// immediately before its side effect.
//
// Materialization is CoW-first: contents move through one `copyFile` call with
// `COPYFILE_FICLONE` (plus `COPYFILE_EXCL` for the no-overwrite guarantee).
// On APFS/reflink filesystems this clones in milliseconds at near-zero disk
// cost; where reflink is unsupported the syscall falls back to an in-kernel
// copy. Hand-rolled read/write stream loops would silently lose the clone and
// are forbidden for this step. Bulk directory clones (`clonefile(2)` on a
// tree) are equally forbidden: unfinished descendant-ACL inheritance and the
// bypass of per-file identity rechecks.
//
// `.worktreeinclude` concept: bb (https://github.com/get-bb/bb)
// `packages/host-workspace/src/worktree-include.ts`, pinned revision
// 52a9256373d4d36f9b60e9e2a7f333464091a2ac, MIT License.
// Copyright (c) 2026 Michael Yong. Hardened per the Dev Runtime spec: hard
// limits, fail-closed rejections, item-level secret approvals, plan digests,
// and CoW clones replace bb's silent skips and unbounded list.
import { constants as fsConstants, copyFileSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { nowIso } from '../authority'
import { runGit, GIT_FIELD_SEPARATOR } from './git-run'
import { WorktreeError } from './errors'
import {
  identityOfPath,
  sameFileIdentityStrict,
  sameIdentity,
  type FileIdentityValue,
} from './identity'

export const WORKTREE_INCLUDE_FILE_NAME = '.worktreeinclude'

// Dev Runtime limits registry: include copy — 1,000 regular files, 100 MiB
// total, 16 MiB per file.
export const INCLUDE_COPY_MAX_FILES = 1_000
export const INCLUDE_COPY_MAX_TOTAL_BYTES = 100 * 1024 * 1024
export const INCLUDE_COPY_MAX_FILE_BYTES = 16 * 1024 * 1024

export type IncludeCopyCandidate = Readonly<{
  relativePath: string
  sizeBytes: number
  sourceIdentity: FileIdentityValue
  secretLike: boolean
}>

export type IncludeCopyPlan = Readonly<{
  sourceRoot: string
  destinationRoot: string
  destinationRootIdentity: FileIdentityValue
  items: ReadonlyArray<IncludeCopyCandidate>
  /** Candidates the plan refuses to copy, with the reason (tracked-content
   *  protection). Every candidate is reported; nothing is skipped silently. */
  excluded: ReadonlyArray<Readonly<{ relativePath: string; reason: 'tracked' }>>
  totalBytes: number
  /** Secret-like approvals bound into this plan (item-relative paths). */
  approvedSecretLike: ReadonlyArray<string>
  digest: string
  createdAt: string
}>

export type IncludeCopyResult = Readonly<{
  copied: ReadonlyArray<string>
  excluded: ReadonlyArray<Readonly<{ relativePath: string; reason: string }>>
  totalBytes: number
}>

const SECRET_LIKE_PATTERN =
  /(^|\/)\.env(\..+)?$|(^|\/)(.+?\.)?(key|pem|p12|pfx|keystore|jks)$|(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\..*)?$|credential|secret|token|password/i

export function isSecretLikePath(relativePath: string): boolean {
  return SECRET_LIKE_PATTERN.test(relativePath)
}

function digestFields(plan: Omit<IncludeCopyPlan, 'digest' | 'createdAt'>): string {
  return JSON.stringify({
    sourceRoot: plan.sourceRoot,
    destinationRoot: plan.destinationRoot,
    destinationRootIdentity: plan.destinationRootIdentity,
    items: plan.items,
    excluded: plan.excluded,
    totalBytes: plan.totalBytes,
    approvedSecretLike: plan.approvedSecretLike,
  })
}

async function readIncludePatterns(sourceRoot: string): Promise<string | null> {
  try {
    const contents = await Bun.file(join(sourceRoot, WORKTREE_INCLUDE_FILE_NAME)).text()
    return contents
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function hasActivePattern(contents: string): boolean {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith('#'))
}

function splitNulList(stdout: string): string[] {
  return stdout.split(GIT_FIELD_SEPARATOR).filter((entry) => entry.length > 0)
}

async function listIgnoredByInclude(sourceRoot: string): Promise<string[]> {
  const result = await runGit(
    ['ls-files', '--others', '--ignored', `--exclude-from=${WORKTREE_INCLUDE_FILE_NAME}`, '-z'],
    { cwd: sourceRoot }
  )
  return splitNulList(result.stdout)
}

async function listTrackedFiles(root: string): Promise<ReadonlySet<string>> {
  const result = await runGit(['ls-files', '-z'], { cwd: root })
  return new Set(splitNulList(result.stdout))
}

/** Build the include-copy plan for one fresh worktree. Fails closed on any
 *  candidate the spec refuses; nothing has been copied when this returns. */
export async function planIncludeCopy(input: {
  sourceRoot: string
  destinationRoot: string
  approvals?: ReadonlyArray<string>
}): Promise<IncludeCopyPlan | { ran: false }> {
  const contents = await readIncludePatterns(input.sourceRoot)
  if (contents === null || !hasActivePattern(contents)) {
    return { ran: false }
  }

  const [candidates, destinationTracked] = await Promise.all([
    listIgnoredByInclude(input.sourceRoot),
    listTrackedFiles(input.destinationRoot),
  ])

  const destinationRootIdentity = identityOfPath(input.destinationRoot)
  const realSourceRoot = realpathSync(input.sourceRoot)
  const approved = new Set(input.approvals ?? [])
  const items: IncludeCopyCandidate[] = []
  const excluded: Array<{ relativePath: string; reason: 'tracked' }> = []

  for (const relativePath of candidates) {
    if (relativePath.length === 0) continue
    if (relativePath === '.git' || relativePath.startsWith('.git/')) continue
    if (isAbsolute(relativePath) || relativePath.split(sep).includes('..')) {
      throw new WorktreeError(
        'path_escape',
        `include candidate escapes the repository: ${relativePath}`
      )
    }
    const absoluteSource = resolve(realSourceRoot, relativePath)
    if (!absoluteSource.startsWith(realSourceRoot + sep)) {
      throw new WorktreeError(
        'path_escape',
        `include candidate escapes the repository: ${relativePath}`
      )
    }

    const sourceStat = lstatSync(absoluteSource, { throwIfNoEntry: false })
    if (!sourceStat) {
      throw new WorktreeError(
        'not_found',
        `include candidate vanished before the plan: ${relativePath}`
      )
    }
    if (sourceStat.isSymbolicLink()) {
      throw new WorktreeError('symlink_rejected', `include candidate is a symlink: ${relativePath}`)
    }
    if (!sourceStat.isFile()) {
      throw new WorktreeError(
        'special_file_rejected',
        `include candidate is not a regular file: ${relativePath}`
      )
    }
    if (destinationTracked.has(relativePath)) {
      // Never overwrite tracked content; the worktree's checkout wins.
      excluded.push({ relativePath, reason: 'tracked' })
      continue
    }

    if (items.length >= INCLUDE_COPY_MAX_FILES) {
      throw new WorktreeError(
        'limit_exceeded',
        `include copy exceeds ${INCLUDE_COPY_MAX_FILES} files`
      )
    }
    if (sourceStat.size > INCLUDE_COPY_MAX_FILE_BYTES) {
      throw new WorktreeError(
        'limit_exceeded',
        `include copy exceeds the ${INCLUDE_COPY_MAX_FILE_BYTES}-byte per-file budget: ${relativePath}`
      )
    }

    items.push({
      relativePath,
      sizeBytes: sourceStat.size,
      sourceIdentity: identityOfPath(absoluteSource),
      secretLike: isSecretLikePath(relativePath),
    })
  }

  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0)
  if (totalBytes > INCLUDE_COPY_MAX_TOTAL_BYTES) {
    throw new WorktreeError(
      'limit_exceeded',
      `include copy exceeds the ${INCLUDE_COPY_MAX_TOTAL_BYTES}-byte total budget`
    )
  }

  const secretItems = items.filter((item) => item.secretLike).map((item) => item.relativePath)
  const unapprovedSecret = secretItems.find((path) => !approved.has(path))
  if (unapprovedSecret) {
    throw new WorktreeError(
      'unauthorized',
      `a secret-like include entry requires explicit item-level approval: ${unapprovedSecret}`
    )
  }
  const unknownApproval = [...approved].find((entry) => !secretItems.includes(entry))
  if (unknownApproval) {
    throw new WorktreeError(
      'invalid_state',
      `an include approval names no secret-like candidate: ${unknownApproval}`
    )
  }

  const fields: Omit<IncludeCopyPlan, 'digest' | 'createdAt'> = {
    sourceRoot: input.sourceRoot,
    destinationRoot: input.destinationRoot,
    destinationRootIdentity,
    items,
    excluded,
    totalBytes,
    approvedSecretLike: secretItems,
  }
  return {
    ...fields,
    digest: createHash('sha256').update(digestFields(fields)).digest('hex'),
    createdAt: nowIso(),
  }
}

/** Apply a plan. Every copy revalidates source identity, destination absence,
 *  and containment immediately before its side effect; a race fails the step
 *  instead of overwriting. */
export async function applyIncludeCopy(input: {
  plan: IncludeCopyPlan
  digest: string
  signal?: AbortSignal
}): Promise<IncludeCopyResult> {
  const plan = input.plan
  if (createHash('sha256').update(digestFields(plan)).digest('hex') !== input.digest) {
    throw new WorktreeError('plan_stale', 'include plan digest does not match the plan')
  }

  // The destination root must still be the directory the plan proved.
  const freshDestination = identityOfPath(plan.destinationRoot)
  if (!sameIdentity(freshDestination, plan.destinationRootIdentity)) {
    throw new WorktreeError('identity_mismatch', 'worktree root changed after the plan was built')
  }

  const destinationRoot = realpathSync(plan.destinationRoot)
  const copied: string[] = []

  for (const item of plan.items) {
    if (input.signal?.aborted) {
      throw new WorktreeError('cancelled', 'include copy was cancelled')
    }
    const absoluteSource = resolve(plan.sourceRoot, item.relativePath)
    const absoluteDestination = resolve(destinationRoot, item.relativePath)

    // Source identity recheck: the file must be the exact bytes the plan saw
    // (an in-place rewrite keeps the inode, so mtime+size join the check),
    // still a regular file (not a symlink swapped in later).
    const freshSource = identityOfPath(absoluteSource)
    if (!sameFileIdentityStrict(freshSource, item.sourceIdentity)) {
      throw new WorktreeError(
        'file_changed',
        `include source changed during copy: ${item.relativePath}`
      )
    }
    const sourceStat = lstatSync(absoluteSource, { throwIfNoEntry: false })
    if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new WorktreeError(
        'special_file_rejected',
        `include source was replaced: ${item.relativePath}`
      )
    }

    // Destination absence recheck (TOCTOU with anything creating files here).
    const existing = lstatSync(absoluteDestination, { throwIfNoEntry: false })
    if (existing) {
      throw new WorktreeError(
        'file_changed',
        `include destination appeared during copy: ${item.relativePath}`
      )
    }

    // Create the destination parents ourselves and prove containment: no
    // symlinked parent, no escape, per file.
    mkdirSync(dirname(absoluteDestination), { recursive: true, mode: 0o755 })
    const parentReal = realpathSync(dirname(absoluteDestination))
    if (parentReal !== destinationRoot && !parentReal.startsWith(destinationRoot + sep)) {
      throw new WorktreeError(
        'path_escape',
        `include destination escapes the worktree: ${item.relativePath}`
      )
    }

    // One CoW clone per file; EXCL keeps the no-overwrite guarantee at the
    // syscall level and FICLONE keeps the clone when the filesystem has it.
    copyFileSync(
      absoluteSource,
      absoluteDestination,
      fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL
    )

    // Post-copy containment recheck: the clone must exist exactly where the
    // plan placed it.
    const placed = realpathSync(absoluteDestination)
    if (!placed.startsWith(destinationRoot + sep)) {
      throw new WorktreeError(
        'path_escape',
        `include destination escaped after copy: ${item.relativePath}`
      )
    }
    copied.push(item.relativePath)
  }

  return { copied, excluded: plan.excluded, totalBytes: plan.totalBytes }
}
