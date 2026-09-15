import { describe, expect, test } from 'bun:test'

import {
  closePane,
  countLeaves,
  createLayoutState,
  listLeaves,
  movePane,
  focusPane,
  resizeSplit,
  splitPane,
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
