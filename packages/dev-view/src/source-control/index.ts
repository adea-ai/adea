/*
 * Source control slice public surface (#399/#423): the utility pane and its
 * pure models. Exported lazily from `@adea-ai/dev-view/source-control`.
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
export {
  aheadBehindLabel,
  checksLabel,
  pullRequestStateLabel,
  reviewDecisionLabel,
  summarizeChecks,
  truncateUntrusted,
  type CheckSummary,
} from './remote-model'
