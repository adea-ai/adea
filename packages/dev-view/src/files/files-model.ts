/*
 * Files pane model (#399): a lazily-loaded directory tree over the paged
 * `dev.files.list` DTO, a visible-row flattening for rendering, client-side
 * filtering with quick-open ranking, and git modified markers from
 * `dev.git.status`. Pure data work — no DOM, no runtime access.
 */
import type { FileEntry } from '@adea-ai/types/dev-runtime'

export type FileTreeNode = Readonly<{
  name: string
  relativePath: string
  kind: FileEntry['kind']
  identity?: FileEntry['identity']
  children: readonly FileTreeNode[]
}>

export type VisibleRow = Readonly<{
  node: FileTreeNode
  depth: number
  hasChildren: boolean
}>

/** Merge one paged directory listing into the tree. Listing entries carry
 *  worktree-relative paths; directories sort before files, then by name —
 *  the same order the provider lists in.
 *
 *  The merge is copy-on-write: only the levels a page actually touches are
 *  copied, and only those levels are re-sorted. Cloning the whole tree per
 *  page made a second page cost as much as the first, which a listing of any
 *  size pays hundreds of times over. */
export function mergeListing(
  nodes: readonly FileTreeNode[],
  entries: readonly FileEntry[]
): readonly FileTreeNode[] {
  if (entries.length === 0) return nodes
  const levels = new Map<string, OpenLevel>()
  const root: OpenLevel = { nodes: nodes.slice() as MutableNode[], positions: new Map() }
  root.nodes.forEach((node, at) => root.positions.set(node.relativePath, at))
  levels.set('', root)

  /** The writable view of a level this merge already owns. */
  const derivedLevel = (node: MutableNode): OpenLevel => {
    const opened: OpenLevel = { nodes: node.children, positions: new Map() }
    opened.nodes.forEach((child, at) => opened.positions.set(child.relativePath, at))
    node.children = opened.nodes
    return opened
  }

  /** The writable view of one level, copied once per merge. The copy replaces
   *  the parent's `children` so the caller's tree is never written to. */
  const openLevel = (
    parentPath: string,
    originals: readonly FileTreeNode[],
    parent: MutableNode
  ): OpenLevel => {
    const existing = levels.get(parentPath)
    if (existing) {
      parent.children = existing.nodes
      return existing
    }
    const opened: OpenLevel = { nodes: originals.slice() as MutableNode[], positions: new Map() }
    opened.nodes.forEach((node, at) => opened.positions.set(node.relativePath, at))
    levels.set(parentPath, opened)
    parent.children = opened.nodes
    return opened
  }

  for (const item of entries) {
    const segments = item.path.relativePath.split('/')
    // `originals` is the level as the caller's tree holds it; it is shorter
    // than the opened level whenever this merge derived nodes of its own, so a
    // missing original means the node is already ours.
    let originals: readonly FileTreeNode[] = nodes
    let open = root
    let parentPath = ''
    for (const [position, segment] of segments.entries()) {
      const pathSoFar = parentPath.length === 0 ? segment : `${parentPath}/${segment}`
      const isLeaf = position === segments.length - 1
      const at = open.positions.get(pathSoFar)
      let childOriginals: readonly FileTreeNode[] | undefined

      if (at === undefined) {
        const created: MutableNode = {
          name: segment,
          relativePath: pathSoFar,
          // An intermediate segment the listing has not reported yet is a
          // directory by construction.
          kind: isLeaf ? item.kind : 'directory',
          ...(isLeaf ? { identity: item.identity } : {}),
          children: [],
        }
        open.nodes.push(created)
        open.positions.set(pathSoFar, open.nodes.length - 1)
        markDirty(open)
        if (isLeaf) {
          // A directory the listing reported as a row of its own still has to
          // be readable as a level once its children arrive.
          if (created.kind === 'directory') levels.set(pathSoFar, derivedLevel(created))
          continue
        }
        const childLevel = derivedLevel(created)
        levels.set(pathSoFar, childLevel)
        open = childLevel
        parentPath = pathSoFar
        continue
      }

      const original = originals[at] as FileTreeNode | undefined
      let node = open.nodes[at] as MutableNode
      if (original !== undefined) {
        if (node === (original as unknown as MutableNode)) {
          // First touch: copy the node. Its children array is shared until the
          // level below is opened, and opening a level always copies it.
          node = {
            name: node.name,
            relativePath: node.relativePath,
            kind: node.kind,
            ...(node.identity !== undefined ? { identity: node.identity } : {}),
            children: node.children,
          }
          open.nodes[at] = node
        }
        childOriginals = original.children
      }

      if (isLeaf) {
        if (node.kind !== item.kind) markDirty(open)
        node.kind = item.kind
        node.identity = item.identity
        continue
      }

      const childLevel =
        childOriginals === undefined
          ? (levels.get(pathSoFar) ?? derivedLevel(open.nodes[at] as MutableNode))
          : openLevel(pathSoFar, childOriginals, open.nodes[at] as MutableNode)
      levels.set(pathSoFar, childLevel)
      open = childLevel
      parentPath = pathSoFar
      if (childOriginals !== undefined) originals = childOriginals
    }
  }

  for (const level of levels.values()) if (level.dirty) sortNodesInPlace(level.nodes)
  return root.nodes
}

type OpenLevel = {
  nodes: MutableNode[]
  positions: Map<string, number>
  dirty?: boolean
}

function markDirty(level: OpenLevel): void {
  level.dirty = true
}

type MutableNode = {
  name: string
  relativePath: string
  kind: FileEntry['kind']
  identity?: FileEntry['identity']
  children: MutableNode[]
}

function sortNodesInPlace(level: MutableNode[]): MutableNode[] {
  const sorted = level.toSorted((left, right) => {
    const leftDir = left.kind === 'directory' ? 0 : 1
    const rightDir = right.kind === 'directory' ? 0 : 1
    if (leftDir !== rightDir) return leftDir - rightDir
    return left.name.localeCompare(right.name)
  })
  sorted.forEach((node, index) => {
    level[index] = node
  })
  return sorted
}

/** Depth-first visible rows: expanded directories expose their children. */
export function visibleRows(
  nodes: readonly FileTreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0
): readonly VisibleRow[] {
  const rows: VisibleRow[] = []
  for (const node of nodes) {
    const hasChildren = node.kind === 'directory'
    rows.push({ node, depth, hasChildren })
    if (hasChildren && expanded.has(node.relativePath)) {
      // Append in place rather than spreading: a directory's whole flattened
      // subtree is passed as one call argument, and a large enough directory
      // overflows the engine's argument limit. Measured on this runtime the
      // spread form survives ~500k arguments and throws a RangeError by ~1M, so
      // this removes a distant but real ceiling rather than a routine one.
      const children = visibleRows(node.children, expanded, depth + 1)
      for (const child of children) rows.push(child)
    }
  }
  return rows
}

/** Keep nodes whose own name/path matches the query, plus every ancestor of
 *  a match, plus directories that still have (filtered) children. */
export function filterTree(nodes: readonly FileTreeNode[], query: string): readonly FileTreeNode[] {
  const needle = query.toLowerCase()
  if (needle.length === 0) return nodes
  const keep: FileTreeNode[] = []
  for (const node of nodes) {
    const children = filterTree(node.children, query)
    const selfMatch =
      node.name.toLowerCase().includes(needle) || node.relativePath.toLowerCase().includes(needle)
    if (selfMatch || children.length > 0) {
      keep.push({ ...node, children })
    }
  }
  return keep
}

/** Quick-open ranking: exact-name matches first, then prefix, then substring
 *  position; ties break by shorter path. Returns ranked relative paths. */
export function rankQuickOpen(
  paths: readonly string[],
  query: string,
  limit = 20
): readonly string[] {
  const needle = query.toLowerCase()
  if (needle.length === 0) return []
  const scored: Array<{ path: string; score: number }> = []
  for (const path of paths) {
    const name = (path.split('/').pop() ?? path).toLowerCase()
    let score = Number.POSITIVE_INFINITY
    if (name === needle) score = 0
    else if (name.startsWith(needle)) score = 1
    else if (name.includes(needle)) score = 2
    else if (path.toLowerCase().includes(needle)) score = 3
    if (score !== Number.POSITIVE_INFINITY) scored.push({ path, score })
  }
  return scored
    .toSorted((left, right) =>
      left.score !== right.score
        ? left.score - right.score
        : left.path.length - right.path.length || left.path.localeCompare(right.path)
    )
    .slice(0, limit)
    .map((entry) => entry.path)
}

/** Characters that start a "word" inside a path: a match right after one of
 *  these (or at position 0) is worth more than a mid-word match. */
const BOUNDARY_CHARS = new Set(['/', '-', '_', '.', ' '])

/** Fuzzy quick-open (v1): case-insensitive in-order subsequence match over
 *  the currently loaded paths. Scoring prefers consecutive runs, matches
 *  after path/word boundaries, and matches inside the filename over matches
 *  in parent directories; ties break by shorter path, then lexicographically.
 *  Bounded results keep the picker O(20) renders. Fuzzy matching rides only
 *  the paths already loaded into the tree — a prebuilt index over the whole
 *  worktree is a future slice (see the dev-runtime spec). */
export function fuzzyQuickOpen(
  paths: readonly string[],
  query: string,
  limit = 20
): readonly string[] {
  const needle = query.toLowerCase()
  if (needle.length === 0) return []
  const scored: Array<{ path: string; score: number }> = []
  for (const path of paths) {
    const score = fuzzyScore(path.toLowerCase(), needle)
    if (score !== undefined) scored.push({ path, score })
  }
  return scored
    .toSorted((left, right) =>
      left.score !== right.score
        ? right.score - left.score
        : left.path.length - right.path.length || left.path.localeCompare(right.path)
    )
    .slice(0, limit)
    .map((entry) => entry.path)
}

/** Deterministic greedy subsequence score: the leftmost match wins, runs of
 *  consecutive matches and boundary-adjacent matches pay bonuses, and a
 *  filename-part match outranks a directory-part match. Returns undefined
 *  when the needle is not a subsequence of the candidate. */
function fuzzyScore(candidate: string, needle: string): number | undefined {
  const filenameStart = candidate.lastIndexOf('/') + 1
  let score = 0
  let needleIndex = 0
  let previousMatch = -2
  for (let index = 0; index < candidate.length && needleIndex < needle.length; index += 1) {
    if (candidate[index] !== needle[needleIndex]) continue
    if (index === previousMatch + 1) score += 8
    if (index === 0 || BOUNDARY_CHARS.has(candidate[index - 1] as string)) score += 10
    if (index >= filenameStart) score += 6
    score += 1
    previousMatch = index
    needleIndex += 1
  }
  if (needleIndex < needle.length) return undefined
  return score
}

export type ModificationMarker = Readonly<{ staged: string; unstaged: string; untracked: boolean }>

type MarkerEntry = Readonly<{
  path: { relativePath: string }
  staged: string
  unstaged: string
  untracked: boolean
}>

/** relativePath → modification marker, for tree badges. */
export function markerMap(
  entries: readonly MarkerEntry[]
): ReadonlyMap<string, ModificationMarker> {
  const map = new Map<string, ModificationMarker>()
  for (const entry of entries) {
    map.set(entry.path.relativePath, {
      staged: entry.staged,
      unstaged: entry.unstaged,
      untracked: entry.untracked,
    })
  }
  return map
}

/** A short badge for a status pair: staged wins visually, untracked shows '?'. */
export function markerBadge(marker: ModificationMarker | undefined): string {
  if (!marker) return ''
  if (marker.untracked) return '?'
  if (marker.staged !== '.') return marker.staged
  if (marker.unstaged !== '.') return marker.unstaged
  return ''
}
