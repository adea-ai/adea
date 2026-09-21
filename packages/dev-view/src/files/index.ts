/*
 * Files slice public surface (#399): the utility pane and its pure model.
 * Exported lazily from `@adea-ai/dev-view/files`.
 */
export { FilesPane, type FilesPaneProps } from './files-pane'
export {
  filterTree,
  fuzzyQuickOpen,
  markerBadge,
  markerMap,
  mergeListing,
  rankQuickOpen,
  visibleRows,
  type FileTreeNode,
  type ModificationMarker,
  type VisibleRow,
} from './files-model'
export { fileChunkSize, readFileViaStream, writeFileViaStream } from './file-stream'
export type { FileStreamSocket, FileStreamTransport } from './file-stream'
export {
  cacheStatus,
  emptyStatusCache,
  invalidateStatus,
  refenceStatusCache,
  type StatusCacheSnapshot,
} from './status-cache'
export { executeOperation, resolveWorktreeContext, type WorktreeContext } from './worktree-context'
