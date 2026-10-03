/*
 * Inbox grouping: every open pull request lands in exactly one group, tested
 * in a fixed order, and each group names the one action the row offers.
 *
 *   1. Drafts            — draft
 *   2. Needs your review — viewer requested and has not reviewed the head
 *   3. Ready to merge    — approvals met, checks passing, not behind, no conflicts
 *   4. Blocked           — failing checks, changes requested, behind, or conflicts
 *   5. Waiting on others — anything else that is open
 *
 * Blocked rows pick their action by first match: failing checks on an agent's
 * session branch open that session; failing checks, requested changes, or
 * conflicts open the pull request; a branch that is only behind offers
 * Update branch unless the head lives in a fork (GitHub refuses those).
 */
import {
  approvalsMet,
  changesRequested,
  checksFailing,
  checksPassing,
  hasConflicts,
  isBehind,
  viewerIsRequested,
  viewerReviewedHead,
} from './status'
import type { InboxGroupId, PullRequestView, RowAction } from './types'

export type Classification = Readonly<{ group: InboxGroupId; action: RowAction }>

export function classifyPullRequest(
  pr: PullRequestView,
  viewer: string | undefined
): Classification {
  if (pr.draft) return { group: 'drafts', action: pr.session ? 'open_session' : 'open' }
  if (viewerIsRequested(pr, viewer) && !viewerReviewedHead(pr, viewer))
    return { group: 'needs_review', action: 'review' }
  const failing = checksFailing(pr.checks)
  const requested = changesRequested(pr)
  const conflicts = hasConflicts(pr)
  const behind = isBehind(pr)
  if (approvalsMet(pr) && checksPassing(pr.checks) && !behind && !conflicts)
    return { group: 'ready', action: 'merge' }
  if (failing || requested || behind || conflicts) {
    if (failing)
      return { group: 'blocked', action: pr.authorIsAgent && pr.session ? 'open_session' : 'open' }
    if (requested || conflicts) return { group: 'blocked', action: 'open' }
    return { group: 'blocked', action: pr.crossRepository ? 'open' : 'update_branch' }
  }
  return { group: 'waiting', action: 'open' }
}

/** Needs you: a review is requested of the viewer, or the viewer's own pull
 *  request is ready to merge or blocked on something they must change. */
export function needsViewer(pr: PullRequestView, viewer: string | undefined): boolean {
  if (pr.state !== 'open' || !viewer) return false
  const { group } = classifyPullRequest(pr, viewer)
  if (group === 'needs_review') return true
  const own = pr.author?.login.toLowerCase() === viewer.toLowerCase()
  return own && (group === 'ready' || group === 'blocked')
}

export type InboxGroup = Readonly<{
  id: InboxGroupId
  label: string
  hint: string
  items: readonly Readonly<{ pr: PullRequestView; action: RowAction }>[]
}>

const GROUPS: readonly Readonly<{ id: InboxGroupId; label: string; hint: string }>[] = [
  {
    id: 'ready',
    label: 'Ready to merge',
    hint: 'Approved, checks passing, up to date with the base',
  },
  { id: 'needs_review', label: 'Needs your review', hint: 'You are a requested reviewer' },
  { id: 'blocked', label: 'Blocked', hint: 'Something has to change before these can merge' },
  { id: 'waiting', label: 'Waiting on others', hint: 'Open and waiting on someone else' },
  { id: 'drafts', label: 'Drafts', hint: 'Still being worked on' },
]

/** Group open pull requests for display. Empty groups are dropped; rows keep
 *  their incoming (most recently updated first) order. */
export function groupInbox(
  prs: readonly PullRequestView[],
  viewer: string | undefined
): readonly InboxGroup[] {
  const buckets = new Map<InboxGroupId, { pr: PullRequestView; action: RowAction }[]>()
  for (const pr of prs) {
    if (pr.state !== 'open') continue
    const { group, action } = classifyPullRequest(pr, viewer)
    const bucket = buckets.get(group) ?? []
    bucket.push({ pr, action })
    buckets.set(group, bucket)
  }
  return GROUPS.flatMap((group) => {
    const items = buckets.get(group.id)
    return items && items.length > 0 ? [{ ...group, items }] : []
  })
}

export const rowActionLabel: Record<RowAction, string> = {
  open_session: 'Open session',
  open: 'Open',
  review: 'Review',
  merge: 'Merge',
  update_branch: 'Update branch',
}

export type InboxFilter = Readonly<{
  text: string
  author?: string
  reviewer?: string
  label?: string
  agentsOnly: boolean
}>

export const emptyInboxFilter: InboxFilter = { text: '', agentsOnly: false }

/** Filter by title, branch, number, author, reviewer, label, or agent authorship. */
export function filterPullRequests(
  prs: readonly PullRequestView[],
  filter: InboxFilter
): readonly PullRequestView[] {
  const needle = filter.text.trim().toLowerCase().replace(/^#/, '')
  return prs.filter((pr) => {
    if (filter.agentsOnly && !pr.authorIsAgent) return false
    if (filter.author && pr.author?.login !== filter.author) return false
    if (
      filter.reviewer &&
      !pr.requestedReviewers.some((r) => r.login === filter.reviewer) &&
      !pr.reviews.some((r) => r.actor.login === filter.reviewer)
    )
      return false
    if (filter.label && !pr.labels.includes(filter.label)) return false
    if (needle.length === 0) return true
    return (
      pr.title.toLowerCase().includes(needle) ||
      pr.headRef.toLowerCase().includes(needle) ||
      String(pr.number) === needle ||
      pr.headSha.startsWith(needle)
    )
  })
}

const sorted = (values: Set<string>) => [...values].toSorted((a, b) => a.localeCompare(b))

/** Distinct facet values for the filter menus, sorted. */
export function filterOptions(prs: readonly PullRequestView[]): Readonly<{
  authors: readonly string[]
  reviewers: readonly string[]
  labels: readonly string[]
}> {
  const authors = new Set<string>()
  const reviewers = new Set<string>()
  const labels = new Set<string>()
  for (const pr of prs) {
    if (pr.author) authors.add(pr.author.login)
    for (const reviewer of pr.requestedReviewers) reviewers.add(reviewer.login)
    for (const review of pr.reviews) reviewers.add(review.actor.login)
    for (const label of pr.labels) labels.add(label)
  }
  return { authors: sorted(authors), reviewers: sorted(reviewers), labels: sorted(labels) }
}
