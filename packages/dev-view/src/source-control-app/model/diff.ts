/*
 * Diff rows for the Files changed view. GitHub hands each file's patch as
 * bare `@@` hunks (no file header), so classification is a small state
 * machine over line prefixes with both line numbers tracked. Unified rows
 * carry the anchor a review comment needs (side and line); split rows pair a
 * run of deletions with the run of additions that follows it.
 */

export type DiffRowKind = 'hunk' | 'context' | 'add' | 'delete' | 'meta'

export type DiffRow = Readonly<{
  kind: DiffRowKind
  text: string
  oldLine?: number
  newLine?: number
}>

/** Where a review comment attaches: GitHub's side and line semantics. */
export type DiffAnchor = Readonly<{ side: 'left' | 'right'; line: number }>

export function parsePatch(patch: string): readonly DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  const lines = patch.split('\n')
  // A patch ending in a newline yields one empty trailing element.
  if (lines.at(-1) === '') lines.pop()
  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }
      rows.push({ kind: 'hunk', text: raw })
      continue
    }
    if (raw.startsWith('\\')) {
      rows.push({ kind: 'meta', text: raw.slice(1).trim() })
      continue
    }
    const marker = raw.charAt(0)
    const text = raw.slice(1)
    if (marker === '+') rows.push({ kind: 'add', text, newLine: newLine++ })
    else if (marker === '-') rows.push({ kind: 'delete', text, oldLine: oldLine++ })
    else rows.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ })
  }
  return rows
}

export function anchorOf(row: DiffRow): DiffAnchor | undefined {
  if (row.kind === 'delete' && row.oldLine !== undefined) return { side: 'left', line: row.oldLine }
  if ((row.kind === 'add' || row.kind === 'context') && row.newLine !== undefined)
    return { side: 'right', line: row.newLine }
  return undefined
}

export function anchorKey(anchor: DiffAnchor): string {
  return `${anchor.side}:${anchor.line}`
}

export type SplitRow =
  | Readonly<{ kind: 'hunk' | 'meta'; text: string }>
  | Readonly<{ kind: 'pair'; left?: DiffRow; right?: DiffRow }>

/** Pair deletions with the additions that follow them, line for line;
 *  context sits on both sides. */
export function splitRows(rows: readonly DiffRow[]): readonly SplitRow[] {
  const out: SplitRow[] = []
  let deletes: DiffRow[] = []
  let adds: DiffRow[] = []
  const flush = () => {
    const count = Math.max(deletes.length, adds.length)
    for (let index = 0; index < count; index += 1) {
      const left = deletes[index]
      const right = adds[index]
      out.push({ kind: 'pair', ...(left ? { left } : {}), ...(right ? { right } : {}) })
    }
    deletes = []
    adds = []
  }
  for (const row of rows) {
    if (row.kind === 'delete') {
      if (adds.length > 0) flush()
      deletes.push(row)
    } else if (row.kind === 'add') {
      adds.push(row)
    } else {
      flush()
      if (row.kind === 'context') out.push({ kind: 'pair', left: row, right: row })
      else out.push({ kind: row.kind, text: row.text })
    }
  }
  flush()
  return out
}

/** The directory/name split for the changed-files tree. */
export function splitPath(path: string): Readonly<{ dir: string; name: string }> {
  const index = path.lastIndexOf('/')
  return index < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, index), name: path.slice(index + 1) }
}

/** Group file paths by directory, directories in first-seen order. */
export function groupByDirectory<T extends { path: string }>(
  files: readonly T[]
): readonly Readonly<{ dir: string; files: readonly T[] }>[] {
  const groups = new Map<string, T[]>()
  for (const file of files) {
    const { dir } = splitPath(file.path)
    const group = groups.get(dir) ?? []
    group.push(file)
    groups.set(dir, group)
  }
  return [...groups.entries()].map(([dir, entries]) => ({ dir, files: entries }))
}
