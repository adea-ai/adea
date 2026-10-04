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
 * The local band-evening split was replaced by the shared balanced reflow
 * (`splitPaneBalanced`, adea-ai/ui#327). See NOTICE and
 * docs/research/dev-view-donor-audit.md.
 */
import type { PaneLeaf } from '@adea-ai/types/dev-runtime'
import {
  closePane as closeSharedPane,
  type BalancedSplitPaneInput as SharedBalancedSplitPaneInput,
  type SplitLayoutState,
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
  splitPaneBalanced,
  undoClosePane,
  focusPane,
  swapPanes,
  movePane,
  resizeSplit,
  normalizeLayout,
  neighborLeaf,
} from '@adea-ai/ui/components/layout/split-layout/model'

export type DevLayoutState = SplitLayoutState<PaneLeaf>
export type BalancedSplitPaneInput = SharedBalancedSplitPaneInput<PaneLeaf>

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
