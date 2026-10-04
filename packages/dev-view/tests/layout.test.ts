import { describe, expect, test } from 'bun:test'

import type { PaneNode } from '@adea-ai/types/dev-runtime'

import {
  closePane,
  countLeaves,
  createLayoutState,
  layoutDepth,
  listLeaves,
  movePane,
  neighborLeaf,
  normalizeLayout,
  focusPane,
  resizeSplit,
  splitPane,
  splitPaneBalanced,
  swapPanes,
  undoClosePane,
} from '../src/layout/operations'

const leaf = (id: string, pane: 'terminal' | 'editor' = 'terminal') => ({
  kind: 'leaf' as const,
  id,
  pane,
})

/** The visible grid a layout renders, counted in whole panes per axis. */
const paneGrid = (node: PaneNode): { rows: number; columns: number } => {
  if (node.kind === 'leaf') return { rows: 1, columns: 1 }
  const first = paneGrid(node.children[0])
  const second = paneGrid(node.children[1])
  return node.direction === 'row'
    ? { rows: Math.max(first.rows, second.rows), columns: first.columns + second.columns }
    : { rows: first.rows + second.rows, columns: Math.max(first.columns, second.columns) }
}

const collectSplitIds = (node: PaneNode): string[] =>
  node.kind === 'leaf' ? [] : [node.id, ...node.children.flatMap(collectSplitIds)]

const collectSplitRatios = (node: PaneNode): number[] =>
  node.kind === 'leaf' ? [] : [node.ratio, ...node.children.flatMap(collectSplitRatios)]

describe('strict binary Dev layout', () => {
  test('splits before or after the target in deterministic reading order', () => {
    const initial = createLayoutState(leaf('terminal-1'))
    const right = splitPane(initial, 'terminal-1', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('editor-1', 'editor'),
      splitId: 'split-1',
    })
    expect(listLeaves(right.center).map((item) => item.id)).toEqual(['terminal-1', 'editor-1'])
    expect(right.focusedLeafId).toBe('editor-1')

    const top = splitPane(initial, 'terminal-1', {
      direction: 'column',
      placement: 'before',
      leaf: leaf('editor-2', 'editor'),
      splitId: 'split-2',
    })
    expect(listLeaves(top.center).map((item) => item.id)).toEqual(['editor-2', 'terminal-1'])
  })

  test('enforces eight leaves and depth eight transactionally', () => {
    let state = createLayoutState(leaf('pane-1'))
    for (let index = 2; index <= 8; index += 1) {
      state = splitPane(state, `pane-${index - 1}`, {
        direction: index % 2 ? 'row' : 'column',
        placement: 'after',
        leaf: leaf(`pane-${index}`),
        splitId: `split-${index}`,
      })
    }
    expect(countLeaves(state.center)).toBe(8)
    expect(() =>
      splitPane(state, 'pane-8', {
        direction: 'row',
        placement: 'after',
        leaf: leaf('pane-9'),
        splitId: 'split-9',
      })
    ).toThrow('limit_exceeded')
  })

  test('closing collapses its parent and final close restores a terminal placeholder', () => {
    const split = splitPane(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two', 'editor'),
      splitId: 'split',
    })
    const closed = closePane(split, 'one', () => 'placeholder')
    expect(closed.center).toEqual(leaf('two', 'editor'))
    expect(closed.focusedLeafId).toBe('two')

    const final = closePane(createLayoutState(leaf('only', 'editor')), 'only', () => 'placeholder')
    expect(final.center).toEqual(leaf('placeholder'))
    expect(final.focusedLeafId).toBe('placeholder')
  })

  test('undo restores the closed leaf and logical focus', () => {
    const initial = splitPane(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two', 'editor'),
      splitId: 'split',
    })
    const closed = closePane(initial, 'two', () => 'placeholder')
    const restored = undoClosePane(closed)
    expect(restored.center).toEqual(initial.center)
    expect(restored.focusedLeafId).toBe('two')
  })

  test('a later structural change invalidates close undo instead of discarding new work', () => {
    const initial = splitPane(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two', 'editor'),
      splitId: 'split',
    })
    const withThree = splitPane(initial, 'two', {
      direction: 'column',
      placement: 'after',
      leaf: leaf('three'),
      splitId: 'nested-split',
    })
    const closed = closePane(withThree, 'three', () => 'placeholder')
    const resized = resizeSplit(closed, 'split', 0.7)
    expect(resized.closed).toHaveLength(0)
    expect(undoClosePane(resized)).toBe(resized)

    const split = splitPane(closed, 'one', {
      direction: 'row',
      placement: 'after',
      splitId: 'later-split',
      leaf: leaf('later'),
    })
    expect(split.closed).toHaveLength(0)

    const swapped = swapPanes(closed, 'one', 'two')
    expect(swapped.closed).toHaveLength(0)
    expect(undoClosePane(swapped)).toBe(swapped)
  })

  test('focuses and swaps existing leaves without changing identities', () => {
    const initial = splitPane(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two', 'editor'),
      splitId: 'split',
    })
    expect(focusPane(initial, 'one').focusedLeafId).toBe('one')
    expect(listLeaves(swapPanes(initial, 'one', 'two').center)).toEqual([
      leaf('two', 'editor'),
      leaf('one'),
    ])
    expect(swapPanes(initial, 'one', 'missing')).toEqual(initial)
  })

  test('moves an existing leaf without changing its identity or exceeding the cap', () => {
    let state = splitPane(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two', 'editor'),
      splitId: 'split-a',
    })
    state = splitPane(state, 'two', {
      direction: 'column',
      placement: 'after',
      leaf: leaf('three'),
      splitId: 'split-b',
    })
    const moved = movePane(state, 'one', 'three', 'before', 'row', 'split-c')
    expect(listLeaves(moved.center).map((item) => item.id)).toEqual(['two', 'one', 'three'])
    expect(listLeaves(moved.center).find((item) => item.id === 'one')).toEqual(leaf('one'))
  })

  test('clamps finite split ratios to the normative range and ignores an unknown split', () => {
    const initial = splitPane(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'split',
    })
    expect(resizeSplit(initial, 'split', 0).center).toMatchObject({ ratio: 0.1 })
    expect(resizeSplit(initial, 'split', 1).center).toMatchObject({ ratio: 0.9 })
    expect(resizeSplit(initial, 'missing', 0.2)).toEqual(initial)
    expect(resizeSplit(initial, 'split', Number.NaN)).toEqual(initial)
  })
})

const nested = () =>
  createLayoutState({
    kind: 'split',
    id: 'root',
    direction: 'row',
    ratio: 0.5,
    children: [
      leaf('a'),
      {
        kind: 'split',
        id: 'inner',
        direction: 'column',
        ratio: 0.5,
        children: [leaf('b', 'editor'), leaf('c')],
      },
    ],
  })

describe('layout normalization and neighbors', () => {
  test('clamps out-of-range ratios and repairs non-finite ones to an even split', () => {
    const state = nested()
    const repaired = normalizeLayout({
      ...state,
      center: {
        kind: 'split',
        id: 'root',
        direction: 'row',
        ratio: 0.97,
        children: [
          leaf('a'),
          {
            kind: 'split',
            id: 'inner',
            direction: 'column',
            ratio: Number.NaN,
            children: [leaf('b', 'editor'), leaf('c')],
          },
        ],
      },
    })
    const root = repaired.center
    if (root.kind !== 'split') throw new Error('expected split root')
    expect(root.ratio).toBe(0.9)
    const inner = root.children[1]
    if (inner.kind !== 'split') throw new Error('expected split inner')
    expect(inner.ratio).toBeCloseTo(0.5)
    expect(listLeaves(repaired.center).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  test('returns the same state when every ratio is already inside the range', () => {
    const state = nested()
    expect(normalizeLayout(state)).toBe(state)
  })

  test('finds reading-order neighbors for pane moves', () => {
    const state = nested()
    expect(neighborLeaf(state, 'a', 1)?.id).toBe('b')
    expect(neighborLeaf(state, 'b', -1)?.id).toBe('a')
    expect(neighborLeaf(state, 'b', 1)?.id).toBe('c')
    expect(neighborLeaf(state, 'c', 1)).toBeUndefined()
    expect(neighborLeaf(state, 'ghost', 1)).toBeUndefined()
  })

  test('move preserves identities and the leaf cap across the cap boundary', () => {
    const state = nested()
    const moved = movePane(state, 'c', 'a', 'before', 'row', 'moved-split')
    expect(listLeaves(moved.center).map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(moved.focusedLeafId).toBe('c')
    expect(countLeaves(moved.center)).toBe(3)
  })
})

describe('splitPaneBalanced', () => {
  test('two panes share one row at half', () => {
    const split = splitPaneBalanced(createLayoutState(leaf('one')), 'one', {
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'split',
    })
    const root = split.center
    if (root.kind !== 'split') throw new Error('expected split root')
    expect(root.direction).toBe('row')
    expect(root.id).toBe('split')
    expect(root.ratio).toBe(0.5)
    expect(split.focusedLeafId).toBe('two')
    expect(split.closed).toHaveLength(0)
  })

  test('the third pane starts a second row in reading order', () => {
    let state = splitPaneBalanced(createLayoutState(leaf('one')), 'one', {
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'row-1',
    })
    state = splitPaneBalanced(state, 'two', {
      placement: 'after',
      leaf: leaf('three'),
      splitId: 'column-1',
    })
    expect(listLeaves(state.center).map((item) => item.id)).toEqual(['one', 'two', 'three'])
    const root = state.center
    if (root.kind !== 'split' || root.direction !== 'column')
      throw new Error('expected column root')
    expect(root.id).toBe('column-1')
    expect(root.ratio).toBe(0.5)
    const row = root.children[0]
    if (row.kind !== 'split' || row.direction !== 'row') throw new Error('expected row split')
    expect(row.ratio).toBe(0.5)
    expect(paneGrid(state.center)).toEqual({ rows: 2, columns: 2 })
  })

  test('splitting to the cap yields two rows of four equal shares within depth', () => {
    let state = createLayoutState(leaf('pane-1'))
    for (let index = 2; index <= 8; index += 1) {
      state = splitPaneBalanced(state, state.focusedLeafId, {
        placement: 'after',
        leaf: leaf(`pane-${index}`),
        splitId: `split-${index}`,
      })
      expect(paneGrid(state.center).rows).toBeLessThanOrEqual(2)
    }
    expect(countLeaves(state.center)).toBe(8)
    expect(paneGrid(state.center)).toEqual({ rows: 2, columns: 4 })
    expect(layoutDepth(state.center)).toBeLessThanOrEqual(8)
    // Equal widths within each row and equal heights across the two rows.
    expect(collectSplitRatios(state.center)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
  })

  test('placement before inserts ahead of the target in reading order', () => {
    const split = splitPaneBalanced(createLayoutState(leaf('one')), 'one', {
      placement: 'before',
      leaf: leaf('editor', 'editor'),
      splitId: 'split',
    })
    expect(listLeaves(split.center).map((item) => item.id)).toEqual(['editor', 'one'])
    expect(split.focusedLeafId).toBe('editor')
  })

  test('surviving leaves keep their objects and split IDs are recycled once each', () => {
    // The shared renderer keys pane owners on the leaf id, so identical leaf
    // objects across the rebuild are what keep a split from remounting a live
    // terminal renderer.
    const original = { kind: 'leaf' as const, id: 'one', pane: 'terminal' as const }
    let state = splitPaneBalanced(createLayoutState(original), 'one', {
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'split-a',
    })
    state = splitPaneBalanced(state, 'two', {
      placement: 'after',
      leaf: leaf('three'),
      splitId: 'split-b',
    })
    expect(listLeaves(state.center)[0]).toBe(original)
    expect(listLeaves(state.center).map((item) => item.id)).toEqual(['one', 'two', 'three'])
    expect(collectSplitIds(state.center).toSorted()).toEqual(['split-a', 'split-b'])
  })

  test('adding a pane rebalances a user-resized layout into equal shares', () => {
    let state = splitPaneBalanced(createLayoutState(leaf('one')), 'one', {
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'row-1',
    })
    state = resizeSplit(state, 'row-1', 0.9)
    state = splitPaneBalanced(state, 'two', {
      placement: 'after',
      leaf: leaf('three'),
      splitId: 'column-1',
    })
    // The automatic reflow recomputes ratios (docs/specs/dev-runtime.md), so a
    // parked 0.9 width gives way to two equal rows of equal-width leaves.
    expect(collectSplitRatios(state.center)).toEqual([0.5, 0.5])
  })

  test('an unknown target returns the same state and the cap still refuses', () => {
    const state = createLayoutState(leaf('one'))
    expect(
      splitPaneBalanced(state, 'ghost', {
        placement: 'after',
        leaf: leaf('two'),
        splitId: 'split',
      })
    ).toBe(state)

    let full = createLayoutState(leaf('pane-1'))
    for (let index = 2; index <= 8; index += 1) {
      full = splitPaneBalanced(full, full.focusedLeafId, {
        placement: 'after',
        leaf: leaf(`pane-${index}`),
        splitId: `split-${index}`,
      })
    }
    expect(() =>
      splitPaneBalanced(full, full.focusedLeafId, {
        placement: 'after',
        leaf: leaf('pane-9'),
        splitId: 'split-9',
      })
    ).toThrow('limit_exceeded')
  })
})

describe('closing every pane', () => {
  test('leaves one fresh terminal placeholder and walks back through the undo stack', () => {
    let state = splitPane(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'row-1',
    })
    state = splitPane(state, 'two', {
      direction: 'column',
      placement: 'after',
      leaf: leaf('three', 'editor'),
      splitId: 'column-1',
    })
    let suffix = 0
    for (const item of listLeaves(state.center)) {
      state = closePane(state, item.id, () => `placeholder-${++suffix}`)
    }
    expect(countLeaves(state.center)).toBe(1)
    // Only the final close needed the placeholder, and focus lands on it.
    expect(listLeaves(state.center)[0]).toEqual(leaf('placeholder-1'))
    expect(state.focusedLeafId).toBe('placeholder-1')

    // Each close pushed its undo point, so the first reopen steps back to the
    // layout just before the last pane closed.
    const reopened = undoClosePane(state)
    expect(listLeaves(reopened.center)).toEqual([leaf('three', 'editor')])
  })
})
