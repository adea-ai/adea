/*
 * Files slice public surface (#399): the utility pane and its pure model.
 * Exported lazily from `@adea-ai/dev-view/files`.
 */
export { FilesPane, type FilesPaneProps } from './files-pane'
export {
  filterTree,
  markerBadge,
  markerMap,
  mergeListing,
  rankQuickOpen,
  visibleRows,
  type FileTreeNode,
  type ModificationMarker,
  type VisibleRow,
} from './files-model'
export { executeOperation, resolveWorktreeContext, type WorktreeContext } from './worktree-context'
