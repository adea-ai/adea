/*
 * Source control app view model. Provider DTOs arrive from the Dev Runtime
 * `dev.github.*` contract (and its `dev.gitlab.*` mirror, same DTOs); this layer adds what only Adea knows — which Adea
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

export type ScmProvider = 'github' | 'gitlab'

/** The provider a pull request id belongs to: GitLab merge requests are
 *  `gl:<path>!<iid>`, GitHub pull requests `gh:<owner>/<repo>#<n>`. */
export function providerOf(pullRequestId: string): ScmProvider {
  return pullRequestId.startsWith('gl:') ? 'gitlab' : 'github'
}

export const providerLabel: Readonly<Record<ScmProvider, string>> = Object.freeze({
  github: 'GitHub',
  gitlab: 'GitLab',
})

/** The display name of the provider hosting a pull request. */
export function hostNameOf(pullRequestId: string): string {
  return providerLabel[providerOf(pullRequestId)]
}

/** What a provider can do. The UI hides an action rather than failing on it. */
export type ProviderCapabilities = Readonly<{
  updateBranch: boolean
  /** How the provider can bring a branch up to date with its base. */
  updateMethods: readonly ('merge' | 'rebase')[]
  autoMerge: boolean
  draft: boolean
  rerunFailedJobs: boolean
  checkLogs: boolean
  /** A review verdict that blocks merging until it is dismissed. */
  requestChanges: boolean
  /** Teams (`org/team`) as reviewers. */
  teamReviewers: boolean
}>

export const githubCapabilities: ProviderCapabilities = Object.freeze({
  updateBranch: true,
  updateMethods: Object.freeze(['merge', 'rebase'] as const),
  autoMerge: true,
  draft: true,
  rerunFailedJobs: true,
  checkLogs: true,
  requestChanges: true,
  teamReviewers: true,
})

/** GitLab rebases a merge request branch (no merge-commit update), records
 *  approvals rather than change requests, and takes people as reviewers. */
export const gitlabCapabilities: ProviderCapabilities = Object.freeze({
  updateBranch: true,
  updateMethods: Object.freeze(['rebase'] as const),
  autoMerge: true,
  draft: true,
  rerunFailedJobs: true,
  checkLogs: true,
  requestChanges: false,
  teamReviewers: false,
})

export function capabilitiesOf(provider: ScmProvider): ProviderCapabilities {
  return provider === 'gitlab' ? gitlabCapabilities : githubCapabilities
}
