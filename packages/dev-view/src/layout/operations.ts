/*
 * Copyright (c) 2026 Michael Yong
 * Copyright (c) 2026 Muxy
 * SPDX-License-Identifier: MIT
 *
 * Portions of the binary split behavior are substantially translated from:
 * - get-bb/bb apps/app/src/lib/split-layout/ops.ts (MIT), revision
 *   52a9256373d4d36f9b60e9e2a7f333464091a2ac.
 * - muxy-app/muxy Muxy/Models/Workspace/SplitNode.swift (MIT), revision
 *   5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6.
 * Modified for immutable strict-binary nodes, Adea limits, and undoable close.
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 */
import type { PaneLeaf, PaneNode, PaneSplit } from '@adea-ai/types/dev-runtime'
import {
  closePane as closeSharedPane,
  countLeaves as countSharedLeaves,
  splitPane as splitSharedPane,
  type SplitLayoutState,
  type SplitPaneInput as SharedSplitPaneInput,
} from '@adea-ai/ui/components/layout/split-layout/model'

export {
  MAX_LAYOUT_LEAVES,
  MAX_LAYOUT_DEPTH,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  listLeaves,
  countLeaves,
  layoutDepth,
  createLayoutState,
  splitPane,
  undoClosePane,
  focusPane,
  swapPanes,
  movePane,
  resizeSplit,
  normalizeLayout,
  neighborLeaf,
} from '@adea-ai/ui/components/layout/split-layout/model'

export type DevLayoutState = SplitLayoutState<PaneLeaf>
export type SplitPaneInput = SharedSplitPaneInput<PaneLeaf>

/** The final pane remains an app-owned terminal placeholder, never a runtime command. */
export function closePane(
  state: DevLayoutState,
  leafId: string,
  createPlaceholderId: () => string
): DevLayoutState {
  return closeSharedPane(state, leafId, () => ({
    kind: 'leaf',
    id: createPlaceholderId(),
    pane: 'terminal',
  }))
}

/** The visible grid a layout renders, counted in whole panes per axis. */
export type PaneGrid = Readonly<{ rows: number; columns: number }>

/**
 * The grid the center layout renders: a row split adds its children side by
 * side (columns sum, rows take the taller), a column split stacks them (rows
 * sum, columns take the wider).
 */
export function paneGrid(node: PaneNode): PaneGrid {
  if (node.kind === 'leaf') return { rows: 1, columns: 1 }
  const first = paneGrid(node.children[0])
  const second = paneGrid(node.children[1])
  return node.direction === 'row'
    ? { rows: Math.max(first.rows, second.rows), columns: first.columns + second.columns }
    : { rows: first.rows + second.rows, columns: Math.max(first.columns, second.columns) }
}

/**
 * The split axis that walks a layout toward two rows of four columns: a single
 * pane opens a second column, a layout that is still one band starts the
 * second row, and once two bands exist the split widens a row. Which row grows
 * stays the user's choice — the axis is all this decides.
 */
export function preferredSplitDirection(node: PaneNode): 'row' | 'column' {
  const grid = paneGrid(node)
  return grid.rows < 2 && grid.columns > 1 ? 'column' : 'row'
}

/**
 * Splits, then evens the band the new pane joined. A plain split halves its
 * target, so a row grown one pane at a time renders its first leaf at half the
 * band and its last at a sliver; the chain of consecutive same-axis splits the
 * new pane joined instead takes the ratios that give every leaf in the band an
 * equal span. Ratios outside the band, and the user's resizes inside other
 * bands, are untouched.
 */
export function splitPaneEvenly(
  state: DevLayoutState,
  targetLeafId: string,
  input: SplitPaneInput
): DevLayoutState {
  const split = splitSharedPane(state, targetLeafId, input)
  const band = evenBand(split.center, input)
  return band ? { ...split, center: band.node } : split
}

/** A leaf's equal share of its band is leaves(left) / leaves(whole), in range by construction. */
function evenRatio(node: PaneSplit): PaneSplit {
  return { ...node, ratio: countSharedLeaves(node.children[0]) / countSharedLeaves(node) }
}

function evenBand(
  node: PaneNode,
  input: SplitPaneInput
): { node: PaneNode; inBand: boolean } | undefined {
  if (node.kind === 'leaf') return undefined
  const [first, second] = node.children
  if (node.id === input.splitId) {
    if (node.direction !== input.direction) return undefined
    return { node: evenRatio(node), inBand: true }
  }
  const walkedFirst = evenBand(first, input)
  if (walkedFirst)
    return wrapEven(
      node,
      [walkedFirst.node, second],
      walkedFirst.inBand && node.direction === input.direction
    )
  const walkedSecond = evenBand(second, input)
  if (walkedSecond)
    return wrapEven(
      node,
      [first, walkedSecond.node],
      walkedSecond.inBand && node.direction === input.direction
    )
  return undefined
}

function wrapEven(
  node: PaneSplit,
  children: readonly [PaneNode, PaneNode],
  inBand: boolean
): { node: PaneNode; inBand: boolean } {
  return inBand
    ? { node: evenRatio({ ...node, children }), inBand: true }
    : { node: { ...node, children }, inBand: false }
}
