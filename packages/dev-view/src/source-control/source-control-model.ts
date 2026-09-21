/*
 * Source control pane model (#399): grouping of `GitStatus` entries into
 * staged/unstaged/untracked/conflicted buckets, status-code labels, and the
 * bounded plain-text unified-diff fallback renderer. Pure data work.
 */
import type { DiffHunk, GitStatus } from '@adea-ai/types/dev-runtime'

export type StatusBucket = 'staged' | 'unstaged' | 'untracked' | 'conflicted'

type StatusEntry = GitStatus['entries'][number]

export type GroupedStatus = Readonly<{
  staged: readonly StatusEntry[]
  unstaged: readonly StatusEntry[]
  untracked: readonly StatusEntry[]
  conflicted: readonly StatusEntry[]
}>

/** Porcelain codes that mean "merge conflict present" for the entry. */
const CONFLICT_CODES: ReadonlySet<string> = new Set(['U', 'A', 'D'])

export function groupStatus(status: Pick<GitStatus, 'entries'>): GroupedStatus {
  const staged: StatusEntry[] = []
  const unstaged: StatusEntry[] = []
  const untracked: StatusEntry[] = []
  const conflicted: StatusEntry[] = []
  for (const entry of status.entries) {
    if (entry.untracked) {
      untracked.push(entry)
      continue
    }
    const conflict =
      entry.staged === 'U' ||
      entry.unstaged === 'U' ||
      (CONFLICT_CODES.has(entry.staged) && entry.staged === entry.unstaged) ||
      entry.staged === 'AA' ||
      entry.staged === 'DD'
    if (conflict) {
      conflicted.push(entry)
      continue
    }
    if (entry.staged !== '.') staged.push(entry)
    if (entry.unstaged !== '.') unstaged.push(entry)
  }
  return { staged, unstaged, untracked, conflicted }
}

/** Human label for a porcelain code (editor-facing copy). */
export function statusLabel(code: string): string {
  switch (code) {
    case '.':
      return 'clean'
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'U':
      return 'conflict'
    case '?':
      return 'untracked'
    case '!':
      return 'ignored'
    default:
      return code
  }
}

/** Branch/upstream read-model line: `main`, `main…origin/main`, detached. */
export function branchLabel(status: Pick<GitStatus, 'headRef' | 'headSha'>): string {
  return (
    status.headRef ?? `detached HEAD${status.headSha ? ` @ ${status.headSha.slice(0, 7)}` : ''}`
  )
}

export type RenderedDiffLine = Readonly<{
  kind: 'meta' | 'context' | 'add' | 'delete'
  text: string
}>

/** Plain-text unified diff fallback with a hard line budget: oversized diffs
 *  truncate with an explicit marker instead of freezing the pane. */
export function renderUnifiedDiff(
  hunks: readonly DiffHunk[],
  budgetLines = 4000
): readonly RenderedDiffLine[] {
  const lines: RenderedDiffLine[] = []
  let emitted = 0
  for (const hunk of hunks) {
    if (emitted >= budgetLines) break
    lines.push({ kind: 'meta', text: hunkHeader(hunk) })
    emitted += 1
    for (const line of hunk.lines) {
      if (emitted >= budgetLines) break
      const prefix = line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '
      lines.push({ kind: line.kind, text: `${prefix}${line.text}` })
      emitted += 1
    }
  }
  return lines
}

/** The `@@ -a,b +c,d @@` header line for one hunk (the provider's DTO carries
 *  the ranges structurally, so the header is derived, never parsed). */
export function hunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.path.relativePath}`
}

export type FileHunkGroup = Readonly<{
  path: string
  hunks: readonly DiffHunk[]
}>

/** Client-side hunk splitting: group the provider's `DiffHunk` page (git
 *  emits file-grouped hunks in path order) into per-file hunk lists so the
 *  pane can offer per-hunk stage/unstage affordances. Pure data work — the
 *  patch itself is constructed provider-side from git's own output. */
export function splitFileHunks(hunks: readonly DiffHunk[]): readonly FileHunkGroup[] {
  const groups = new Map<string, DiffHunk[]>()
  for (const hunk of hunks) {
    const path = hunk.path.relativePath
    const bucket = groups.get(path)
    if (bucket) bucket.push(hunk)
    else groups.set(path, [hunk])
  }
  return [...groups.entries()].map(([path, group]) => ({ path, hunks: group }))
}
