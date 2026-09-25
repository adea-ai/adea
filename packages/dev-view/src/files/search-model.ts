/*
 * Content search (#399 residue): the Files pane could filter the listing it
 * already held, but `dev.files.search` — the host-side, ripgrep-backed search —
 * had no caller anywhere in the product. This is the client half: what to ask
 * for, how a match becomes a row, and how the preview highlight is cut.
 */
import type { FileIdentity, SearchMatch, WorkspacePath } from '@adea-ai/types/dev-runtime'

/** One match, as the results list renders it. */
export type ContentSearchRow = Readonly<{
  path: WorkspacePath
  identity: FileIdentity
  line: number
  column: number
  preview: string
  ranges: ReadonlyArray<Readonly<{ start: number; end: number }>>
}>

/** The page the pane asks for; the provider caps it again on its side. */
export const CONTENT_SEARCH_LIMIT = 200

/** Query text worth sending: whitespace would match every file, and the wire
 *  bound is 4096 characters. */
export function searchQuery(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed.slice(0, 4096)
}

export function contentSearchBody(worktreeId: string, query: string): Record<string, unknown> {
  return { limit: CONTENT_SEARCH_LIMIT, query, worktreeId }
}

export function contentSearchRows(matches: readonly SearchMatch[]): readonly ContentSearchRow[] {
  return matches.map((match) => ({
    column: match.column,
    identity: match.identity,
    line: match.line,
    path: match.path,
    preview: match.preview,
    ranges: match.ranges,
  }))
}

/** `path:line` is what a person reads and what a screen reader announces. */
export function matchLabel(row: ContentSearchRow): string {
  return `${row.path.relativePath}:${row.line}`
}

export function matchSummary(rows: readonly ContentSearchRow[], truncated: boolean): string {
  if (rows.length === 0) return 'No matches in this worktree.'
  const fileCount = new Set(rows.map((row) => row.path.relativePath)).size
  const matches = `${rows.length} ${rows.length === 1 ? 'match' : 'matches'} in ${fileCount} ${
    fileCount === 1 ? 'file' : 'files'
  }`
  return truncated ? `${matches} (showing the first ${rows.length})` : matches
}

/**
 * Cuts the preview into plain and matched spans. Ranges arrive from ripgrep in
 * byte order but nothing guarantees they are sorted or disjoint, so they are
 * sorted here and a range that overlaps the cursor contributes only what the
 * previous range left.
 */
export function previewSegments(
  row: ContentSearchRow
): readonly Readonly<{ text: string; match: boolean }>[] {
  const segments: { text: string; match: boolean }[] = []
  let cursor = 0
  for (const range of row.ranges.toSorted((left, right) => left.start - right.start)) {
    if (range.start > cursor)
      segments.push({ match: false, text: row.preview.slice(cursor, range.start) })
    const start = Math.max(range.start, cursor)
    if (range.end > start) segments.push({ match: true, text: row.preview.slice(start, range.end) })
    cursor = Math.max(cursor, range.end)
  }
  if (cursor < row.preview.length) segments.push({ match: false, text: row.preview.slice(cursor) })
  return segments
}
