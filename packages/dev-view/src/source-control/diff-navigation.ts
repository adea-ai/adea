/*
 * Keyboard diff navigation (#677 — the #399 acceptance gap "no keyboard
 * diff-flow coverage"). The diff surface supports next/previous hunk and
 * next/previous file entirely from the keyboard: focus moves across file
 * boundaries, clamps at both ends, never aims at a hunk that does not exist,
 * and Enter activates the focused hunk's own bar button. Pure model — the
 * pane binds it.
 */

/** A focused hunk: its file group and its index inside that group. */
export type DiffPosition = Readonly<{ group: number; hunk: number }>

export type DiffMove = 'next-hunk' | 'previous-hunk' | 'next-file' | 'previous-file'

export type DiffKeyAction = DiffMove | 'primary'

/** The only structure navigation needs, so both the raw hunk groups and the
 *  worker's rendered groups drive the same movement. */
export type DiffGroupLike = Readonly<{ hunks: readonly unknown[] }>

/** The first hunk of the diff, when the diff has one. */
export function firstDiffPosition(groups: readonly DiffGroupLike[]): DiffPosition | undefined {
  const group = groups.findIndex((candidate) => candidate.hunks.length > 0)
  return group === -1 ? undefined : { group, hunk: 0 }
}

function countHunks(groups: readonly DiffGroupLike[]): number {
  return groups.reduce((total, group) => total + group.hunks.length, 0)
}

function clampToHunk(groups: readonly DiffGroupLike[], position: DiffPosition): DiffPosition {
  const group = Math.min(Math.max(position.group, 0), groups.length - 1)
  const hunks = groups[group]?.hunks.length ?? 0
  const hunk = Math.min(Math.max(position.hunk, 0), Math.max(hunks - 1, 0))
  return { group, hunk }
}

function seek(groups: readonly DiffGroupLike[], from: DiffPosition, step: 1 | -1): DiffPosition {
  const candidate = { group: from.group, hunk: from.hunk + step }
  if (candidate.hunk >= 0 && candidate.hunk < (groups[candidate.group]?.hunks.length ?? 0)) {
    return candidate
  }
  // Walk file groups in direction until a group with hunks appears.
  let group = from.group + step
  while (group >= 0 && group < groups.length) {
    if ((groups[group]?.hunks.length ?? 0) > 0) {
      return step === 1 ? { group, hunk: 0 } : { group, hunk: groups[group].hunks.length - 1 }
    }
    group += step
  }
  return clampToHunk(groups, from)
}

/** Focus movement with clamping: an edge move keeps focus on the edge hunk
 *  instead of vanishing, and an empty diff has no position to move. File
 *  moves always land on a different group (its first hunk); a hunk move that
 *  runs out of groups clamps on the edge hunk. */
export function moveDiffFocus(
  groups: readonly DiffGroupLike[],
  from: DiffPosition,
  move: DiffMove
): DiffPosition {
  if (groups.length === 0 || countHunks(groups) === 0) return from
  const origin = clampToHunk(groups, from)
  switch (move) {
    case 'next-hunk':
      return seek(groups, origin, 1)
    case 'previous-hunk':
      return seek(groups, origin, -1)
    case 'next-file':
    case 'previous-file': {
      const step = move === 'next-file' ? 1 : -1
      for (let group = origin.group + step; group >= 0 && group < groups.length; group += step) {
        if ((groups[group]?.hunks.length ?? 0) > 0) return { group, hunk: 0 }
      }
      return origin
    }
  }
}

/** One key interpreter for the diff surface. Plain keys only: anything with
 *  ctrl/meta/alt belongs to the workspace shortcuts and is ignored here. */
export function diffKeyAction(event: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}): DiffKeyAction | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined
  switch (event.key) {
    case 'j':
    case 'J':
    case 'ArrowDown':
      return 'next-hunk'
    case 'k':
    case 'K':
    case 'ArrowUp':
      return 'previous-hunk'
    case 'n':
    case 'N':
      return 'next-file'
    case 'p':
    case 'P':
      return 'previous-file'
    case 'Enter':
      return 'primary'
    default:
      return undefined
  }
}

/** The focused hunk's primary action for the diff's mode. */
export function primaryDiffAction(mode: 'worktree' | 'staged'): 'stage' | 'unstage' {
  return mode === 'staged' ? 'unstage' : 'stage'
}
