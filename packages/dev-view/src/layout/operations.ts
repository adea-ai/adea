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

export const MAX_LAYOUT_LEAVES = 8
export const MAX_LAYOUT_DEPTH = 8
export const MIN_SPLIT_RATIO = 0.1
export const MAX_SPLIT_RATIO = 0.9

export type DevLayoutState = Readonly<{
  center: PaneNode
  focusedLeafId: string
  closed: readonly Readonly<{ center: PaneNode; leafId: string }>[]
}>

export type SplitPaneInput = Readonly<{
  direction: PaneSplit['direction']
  placement: 'before' | 'after'
  leaf: PaneLeaf
  splitId: string
}>

export function listLeaves(node: PaneNode): readonly PaneLeaf[] {
  return node.kind === 'leaf'
    ? [node]
    : [...listLeaves(node.children[0]), ...listLeaves(node.children[1])]
}

export function countLeaves(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : countLeaves(node.children[0]) + countLeaves(node.children[1])
}

export function layoutDepth(node: PaneNode): number {
  return node.kind === 'leaf'
    ? 1
    : 1 + Math.max(layoutDepth(node.children[0]), layoutDepth(node.children[1]))
}

function replaceLeaf(node: PaneNode, leafId: string, replacement: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node.id === leafId ? replacement : node
  const first = replaceLeaf(node.children[0], leafId, replacement)
  const second = replaceLeaf(node.children[1], leafId, replacement)
  return first === node.children[0] && second === node.children[1]
    ? node
    : { ...node, children: [first, second] }
}

function removeLeaf(node: PaneNode, leafId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.id === leafId ? null : node
  const first = removeLeaf(node.children[0], leafId)
  const second = removeLeaf(node.children[1], leafId)
  if (!first) return second
  if (!second) return first
  return first === node.children[0] && second === node.children[1]
    ? node
    : { ...node, children: [first, second] }
}

function containsLeaf(node: PaneNode, leafId: string): boolean {
  return node.kind === 'leaf'
    ? node.id === leafId
    : containsLeaf(node.children[0], leafId) || containsLeaf(node.children[1], leafId)
}

function assertUniqueInput(state: DevLayoutState, leaf: PaneLeaf, splitId: string) {
  const ids = new Set<string>()
  const visit = (node: PaneNode) => {
    if (ids.has(node.id)) throw new Error('invalid_state: duplicate pane id')
    ids.add(node.id)
    if (node.kind === 'split') node.children.forEach(visit)
  }
  visit(state.center)
  if (ids.has(leaf.id) || ids.has(splitId) || leaf.id === splitId)
    throw new Error('invalid_state: duplicate pane id')
}

export function createLayoutState(center: PaneNode): DevLayoutState {
  const first = listLeaves(center)[0]
  if (!first) throw new Error('invalid_state: layout requires a leaf')
  return { center, focusedLeafId: first.id, closed: [] }
}

export function splitPane(
  state: DevLayoutState,
  targetLeafId: string,
  input: SplitPaneInput
): DevLayoutState {
  if (!containsLeaf(state.center, targetLeafId)) return state
  if (countLeaves(state.center) >= MAX_LAYOUT_LEAVES)
    throw new Error('limit_exceeded: center layout has eight leaves')
  assertUniqueInput(state, input.leaf, input.splitId)
  const target = listLeaves(state.center).find((leaf) => leaf.id === targetLeafId)!
  const children =
    input.placement === 'before' ? ([input.leaf, target] as const) : ([target, input.leaf] as const)
  const center = replaceLeaf(state.center, targetLeafId, {
    kind: 'split',
    id: input.splitId,
    direction: input.direction,
    ratio: 0.5,
    children,
  })
  if (layoutDepth(center) > MAX_LAYOUT_DEPTH)
    throw new Error('limit_exceeded: center layout depth exceeds eight')
  return { ...state, center, focusedLeafId: input.leaf.id, closed: [] }
}

export function closePane(
  state: DevLayoutState,
  leafId: string,
  createPlaceholderId: () => string
): DevLayoutState {
  if (!containsLeaf(state.center, leafId)) return state
  const before = state.center
  const readingOrder = listLeaves(before)
  const closedIndex = readingOrder.findIndex((leaf) => leaf.id === leafId)
  const removed = removeLeaf(before, leafId)
  const center: PaneNode = removed ?? {
    kind: 'leaf',
    id: createPlaceholderId(),
    pane: 'terminal',
  }
  const leaves = listLeaves(center)
  const fallback = leaves[Math.min(closedIndex, leaves.length - 1)] ?? leaves[0]!
  return {
    center,
    focusedLeafId: state.focusedLeafId === leafId ? fallback.id : state.focusedLeafId,
    closed: [...state.closed, { center: before, leafId }],
  }
}

export function undoClosePane(state: DevLayoutState): DevLayoutState {
  const previous = state.closed.at(-1)
  if (!previous) return state
  return {
    center: previous.center,
    focusedLeafId: previous.leafId,
    closed: state.closed.slice(0, -1),
  }
}

export function focusPane(state: DevLayoutState, leafId: string): DevLayoutState {
  return containsLeaf(state.center, leafId) && state.focusedLeafId !== leafId
    ? { ...state, focusedLeafId: leafId }
    : state
}

export function swapPanes(
  state: DevLayoutState,
  firstLeafId: string,
  secondLeafId: string
): DevLayoutState {
  if (firstLeafId === secondLeafId) return state
  const leaves = listLeaves(state.center)
  const first = leaves.find((leaf) => leaf.id === firstLeafId)
  const second = leaves.find((leaf) => leaf.id === secondLeafId)
  if (!first || !second) return state
  const swap = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id === firstLeafId) return second
      if (node.id === secondLeafId) return first
      return node
    }
    const left = swap(node.children[0])
    const right = swap(node.children[1])
    return left === node.children[0] && right === node.children[1]
      ? node
      : { ...node, children: [left, right] }
  }
  return { ...state, center: swap(state.center), closed: [] }
}

export function movePane(
  state: DevLayoutState,
  leafId: string,
  targetLeafId: string,
  placement: 'before' | 'after',
  direction: PaneSplit['direction'],
  splitId: string
): DevLayoutState {
  if (leafId === targetLeafId) return state
  const moving = listLeaves(state.center).find((leaf) => leaf.id === leafId)
  if (!moving || !containsLeaf(state.center, targetLeafId)) return state
  const detached = removeLeaf(state.center, leafId)
  if (!detached) return state
  const moved = splitPane(
    { center: detached, focusedLeafId: state.focusedLeafId, closed: state.closed },
    targetLeafId,
    { direction, placement, leaf: moving, splitId }
  )
  return { ...moved, focusedLeafId: leafId }
}

export function resizeSplit(state: DevLayoutState, splitId: string, ratio: number): DevLayoutState {
  if (!Number.isFinite(ratio)) return state
  const nextRatio = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
  let found = false
  const visit = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') return node
    if (node.id === splitId) {
      found = true
      return node.ratio === nextRatio ? node : { ...node, ratio: nextRatio }
    }
    const first = visit(node.children[0])
    const second = visit(node.children[1])
    return first === node.children[0] && second === node.children[1]
      ? node
      : { ...node, children: [first, second] }
  }
  const center = visit(state.center)
  return found && center !== state.center ? { ...state, center, closed: [] } : state
}

/**
 * Pure repair walk ported from bb's size normalization: every split ratio is
 * clamped into the normative range and a non-finite ratio falls back to an
 * even split. Structure, IDs, and focus are untouched.
 */
export function normalizeLayout(state: DevLayoutState): DevLayoutState {
  const visit = (node: PaneNode): { node: PaneNode; changed: boolean } => {
    if (node.kind === 'leaf') return { node, changed: false }
    const first = visit(node.children[0])
    const second = visit(node.children[1])
    const ratio = Number.isFinite(node.ratio)
      ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, node.ratio))
      : (MIN_SPLIT_RATIO + MAX_SPLIT_RATIO) / 2
    const changed = first.changed || second.changed || ratio !== node.ratio
    return {
      node: changed ? { ...node, ratio, children: [first.node, second.node] } : node,
      changed,
    }
  }
  const result = visit(state.center)
  return result.changed ? { ...state, center: result.node } : state
}

/** The leaf immediately after (`1`) or before (`-1`) the given leaf in reading order. */
export function neighborLeaf(
  state: DevLayoutState,
  leafId: string,
  step: 1 | -1
): PaneLeaf | undefined {
  const leaves = listLeaves(state.center)
  const index = leaves.findIndex((leaf) => leaf.id === leafId)
  if (index < 0) return undefined
  return leaves[index + step]
}
