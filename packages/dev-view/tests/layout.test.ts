import { describe, expect, test } from 'bun:test'

import {
  closePane,
  countLeaves,
  createLayoutState,
  listLeaves,
  movePane,
  neighborLeaf,
  normalizeLayout,
  focusPane,
  paneGrid,
  preferredSplitDirection,
  resizeSplit,
  splitPane,
  splitPaneEvenly,
  swapPanes,
  undoClosePane,
} from '../src/layout/operations'

const leaf = (id: string, pane: 'terminal' | 'editor' = 'terminal') => ({
  kind: 'leaf' as const,
  id,
  pane,
})

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

describe('split direction toward two rows of four columns', () => {
  test('a single pane opens a second column', () => {
    expect(preferredSplitDirection(leaf('one'))).toBe('row')
  })

  test('a layout that is still one band starts the second row', () => {
    const row = splitPane(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'row-split',
    })
    expect(paneGrid(row.center)).toEqual({ rows: 1, columns: 2 })
    expect(preferredSplitDirection(row.center)).toBe('column')
  })

  test('once two bands exist the split widens a row', () => {
    const stacked = splitPane(createLayoutState(leaf('one')), 'one', {
      direction: 'column',
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'column-split',
    })
    expect(paneGrid(stacked.center)).toEqual({ rows: 2, columns: 1 })
    expect(preferredSplitDirection(stacked.center)).toBe('row')
  })

  test('splitting the focused pane to the cap stays within two bands', () => {
    let state = createLayoutState(leaf('pane-1'))
    for (let index = 2; index <= 8; index += 1) {
      state = splitPaneEvenly(state, state.focusedLeafId, {
        direction: preferredSplitDirection(state.center),
        placement: 'after',
        leaf: leaf(`pane-${index}`),
        splitId: `split-${index}`,
      })
      expect(paneGrid(state.center).rows).toBeLessThanOrEqual(2)
    }
    expect(countLeaves(state.center)).toBe(8)
    expect(paneGrid(state.center).rows).toBe(2)
  })
})

describe('splitPaneEvenly', () => {
  test('a fresh band keeps an even half-and-half split', () => {
    const split = splitPaneEvenly(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'split',
    })
    const root = split.center
    if (root.kind !== 'split') throw new Error('expected split root')
    expect(root.ratio).toBe(0.5)
  })

  test('a row grown past two panes equalizes every leaf in the band', () => {
    let state = splitPaneEvenly(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'row-1',
    })
    state = splitPaneEvenly(state, 'two', {
      direction: 'column',
      placement: 'after',
      leaf: leaf('three'),
      splitId: 'column-1',
    })
    state = splitPaneEvenly(state, 'three', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('four'),
      splitId: 'row-2',
    })
    state = splitPaneEvenly(state, 'four', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('five'),
      splitId: 'row-3',
    })
    // The bottom band grew one pane at a time; its chain of row splits takes
    // the 1/3, then 1/4, ratios instead of halving into a sliver.
    const root = state.center
    if (root.kind !== 'split') throw new Error('expected row root')
    const column = root.children[1]
    if (column.kind !== 'split' || column.direction !== 'column')
      throw new Error('expected column split')
    expect(root.ratio).toBe(0.5)
    expect(column.ratio).toBe(0.5)
    const band = column.children[1]
    if (band.kind !== 'split' || band.direction !== 'row') throw new Error('expected row band')
    expect(band.ratio).toBeCloseTo(1 / 3)
    const inner = band.children[1]
    if (inner.kind !== 'split') throw new Error('expected inner row split')
    expect(inner.ratio).toBe(0.5)
  })

  test('ratios outside the joined band are untouched', () => {
    let state = splitPaneEvenly(createLayoutState(leaf('one')), 'one', {
      direction: 'row',
      placement: 'after',
      leaf: leaf('two'),
      splitId: 'row-1',
    })
    state = splitPane(state, 'two', {
      direction: 'column',
      placement: 'after',
      leaf: leaf('three'),
      splitId: 'column-1',
    })
    state = resizeSplit(state, 'row-1', 0.7)
    state = splitPaneEvenly(state, 'three', {
      direction: 'column',
      placement: 'after',
      leaf: leaf('four'),
      splitId: 'column-2',
    })
    const root = state.center
    if (root.kind !== 'split') throw new Error('expected row root')
    const column = root.children[1]
    if (column.kind !== 'split') throw new Error('expected column split')
    // The column band evened — L2 takes a third, the new pair two thirds —
    // while the user's 0.7 resize of the row split outside it stands.
    expect(root.ratio).toBe(0.7)
    expect(column.ratio).toBeCloseTo(1 / 3)
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
