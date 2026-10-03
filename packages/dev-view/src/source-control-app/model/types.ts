/*
 * Source control app view model. Provider DTOs arrive from the Dev Runtime
 * `dev.github.*` contract; this layer adds what only Adea knows — which Adea
 * session produced a pull request, and so whether its author is an agent —
 * and names the UI's own vocabulary (pull request, checks) independent of a
 * provider's.
 */
import type { GitHubPullRequestSummary } from '@adea-ai/types/dev-runtime'

/** The Adea runtime session whose worktree has the pull request's head
 *  branch checked out. Derived at read time; never stored. */
export type LinkedSession = Readonly<{
  runtimeSessionId: string
  projectId: string
  worktreeId: string
  title: string
  lifecycle: string
}>

export type PullRequestView = GitHubPullRequestSummary &
  Readonly<{
    /** A bot author, or a branch an Adea session produced. */
    authorIsAgent: boolean
    session?: LinkedSession
  }>

export type InboxGroupId = 'drafts' | 'needs_review' | 'ready' | 'blocked' | 'waiting'

export type RowAction = 'open_session' | 'open' | 'review' | 'merge' | 'update_branch'

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'unknown'

/** What a provider can do. The UI hides an action rather than failing on it. */
export type ProviderCapabilities = Readonly<{
  updateBranch: boolean
  autoMerge: boolean
  draft: boolean
  rerunFailedJobs: boolean
  checkLogs: boolean
}>

export const githubCapabilities: ProviderCapabilities = Object.freeze({
  updateBranch: true,
  autoMerge: true,
  draft: true,
  rerunFailedJobs: true,
  checkLogs: true,
})
