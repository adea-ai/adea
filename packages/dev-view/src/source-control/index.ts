/*
 * Source control slice public surface (#399): the utility pane and its pure
 * model. Exported lazily from `@adea-ai/dev-view/source-control`.
 */
export { SourceControlPane, type SourceControlPaneProps } from './source-control-pane'
export {
  branchLabel,
  groupStatus,
  renderUnifiedDiff,
  statusLabel,
  type GroupedStatus,
  type RenderedDiffLine,
  type StatusBucket,
} from './source-control-model'
