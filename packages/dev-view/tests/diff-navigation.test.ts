/*
 * Keyboard diff navigation tests (#677 — the #399 acceptance gap "no
 * keyboard diff-flow coverage"). Focus moves hunk-to-hunk across file
 * boundaries and file-to-file directly, clamps at both ends of the diff,
 * never aims outside an existing hunk, and one key interpreter maps the
 * diff keys without fighting the workspace modifier shortcuts.
 */
import { describe, expect, test } from 'bun:test'

import type { DiffHunk } from '@adea-ai/types/dev-runtime'

import {
  diffKeyAction,
  firstDiffPosition,
  moveDiffFocus,
  primaryDiffAction,
} from '../src/source-control/diff-navigation'
import { splitFileHunks } from '../src/source-control/source-control-model'

function hunk(relativePath: string, oldStart: number): DiffHunk {
  return {
    path: {
      worktreeId: 'wt',
      rootIdentity: { mtimeNs: '1', size: '1' },
      relativePath,
    },
    oldStart,
    oldLines: 1,
    newStart: oldStart,
    newLines: 1,
    lines: [{ kind: 'context', text: 'x' }],
  }
}

/** a.ts: hunks 1,2 — b.ts: hunk 3 — c.ts: hunks 4,5 */
const GROUPS = splitFileHunks([
  hunk('a.ts', 1),
  hunk('a.ts', 2),
  hunk('b.ts', 3),
  hunk('c.ts', 4),
  hunk('c.ts', 5),
])

describe('keyboard diff navigation', () => {
  test('the first position is the first hunk of the first non-empty group', () => {
    expect(firstDiffPosition(GROUPS)).toEqual({ group: 0, hunk: 0 })
    expect(firstDiffPosition([{ path: 'empty.ts', hunks: [] }, ...GROUPS])).toEqual({
      group: 1,
      hunk: 0,
    })
    expect(firstDiffPosition([])).toBeUndefined()
  })

  test('next/previous hunk cross file boundaries and clamp at both ends', () => {
    const start = firstDiffPosition(GROUPS)!
    expect(moveDiffFocus(GROUPS, start, 'previous-hunk')).toEqual(start)

    expect(moveDiffFocus(GROUPS, start, 'next-hunk')).toEqual({ group: 0, hunk: 1 })
    expect(moveDiffFocus(GROUPS, { group: 0, hunk: 1 }, 'next-hunk')).toEqual({
      group: 1,
      hunk: 0,
    })
    expect(moveDiffFocus(GROUPS, { group: 1, hunk: 0 }, 'next-hunk')).toEqual({
      group: 2,
      hunk: 0,
    })
    expect(moveDiffFocus(GROUPS, { group: 2, hunk: 1 }, 'next-hunk')).toEqual({
      group: 2,
      hunk: 1,
    })

    expect(moveDiffFocus(GROUPS, { group: 2, hunk: 1 }, 'previous-hunk')).toEqual({
      group: 2,
      hunk: 0,
    })
    expect(moveDiffFocus(GROUPS, { group: 2, hunk: 0 }, 'previous-hunk')).toEqual({
      group: 1,
      hunk: 0,
    })
  })

  test('next/previous file land on the first hunk of a different group and clamp', () => {
    const start = firstDiffPosition(GROUPS)!
    expect(moveDiffFocus(GROUPS, start, 'previous-file')).toEqual(start)

    expect(moveDiffFocus(GROUPS, { group: 0, hunk: 1 }, 'next-file')).toEqual({
      group: 1,
      hunk: 0,
    })
    expect(moveDiffFocus(GROUPS, { group: 1, hunk: 0 }, 'previous-file')).toEqual({
      group: 0,
      hunk: 0,
    })
    const lastGroup = GROUPS.length - 1
    expect(moveDiffFocus(GROUPS, { group: lastGroup, hunk: 0 }, 'next-file')).toEqual({
      group: lastGroup,
      hunk: 0,
    })
  })

  test('an empty or hunkless diff has nowhere to move', () => {
    const empty: [] = []
    expect(moveDiffFocus(empty, { group: 0, hunk: 0 }, 'next-hunk')).toEqual({
      group: 0,
      hunk: 0,
    })
    const hunkless = [{ path: 'a.ts', hunks: [] }]
    expect(moveDiffFocus(hunkless, { group: 0, hunk: 3 }, 'next-hunk')).toEqual({
      group: 0,
      hunk: 3,
    })
  })

  test('out-of-range positions clamp into the existing hunk grid', () => {
    expect(moveDiffFocus(GROUPS, { group: 99, hunk: 99 }, 'next-hunk')).toEqual({
      group: 2,
      hunk: 1,
    })
    expect(moveDiffFocus(GROUPS, { group: -5, hunk: -5 }, 'previous-hunk')).toEqual({
      group: 0,
      hunk: 0,
    })
  })

  test('one interpreter maps diff keys and defers every modifier combination', () => {
    expect(diffKeyAction({ key: 'j' })).toBe('next-hunk')
    expect(diffKeyAction({ key: 'ArrowDown' })).toBe('next-hunk')
    expect(diffKeyAction({ key: 'k' })).toBe('previous-hunk')
    expect(diffKeyAction({ key: 'ArrowUp' })).toBe('previous-hunk')
    expect(diffKeyAction({ key: 'n' })).toBe('next-file')
    expect(diffKeyAction({ key: 'p' })).toBe('previous-file')
    expect(diffKeyAction({ key: 'Enter' })).toBe('primary')

    // Workspace shortcuts (ctrl/meta/alt chords) never reach the diff.
    expect(diffKeyAction({ key: 'j', metaKey: true })).toBeUndefined()
    expect(diffKeyAction({ key: 'ArrowDown', ctrlKey: true })).toBeUndefined()
    expect(diffKeyAction({ key: 'ArrowUp', altKey: true })).toBeUndefined()
    expect(diffKeyAction({ key: 'x' })).toBeUndefined()
    expect(diffKeyAction({ key: 'Shift' })).toBeUndefined()
  })

  test('the primary action follows the diff mode', () => {
    expect(primaryDiffAction('worktree')).toBe('stage')
    expect(primaryDiffAction('staged')).toBe('unstage')
  })
})
