/* The app-level actions every surface can request. The app owns the one
 * confirmation dialog per consequential action, the notices, and routing. */
import type { PrTab } from '../model/persistence'
import type { LinkedSession, PullRequestView } from '../model/types'

export type AppActions = Readonly<{
  openPullRequest(pr: Pick<PullRequestView, 'id' | 'repoId'>, tab?: PrTab): void
  openSession(session: LinkedSession): void
  /** Opens the merge confirmation for the pull request. */
  requestMerge(pr: PullRequestView): void
  /** Opens the update-branch confirmation with the chosen strategy. */
  requestUpdateBranch(pr: PullRequestView, method: 'merge' | 'rebase'): void
  newPullRequest(repoId: string, headRef?: string): void
  notify(message: string, tone?: 'success' | 'error'): void
}>
