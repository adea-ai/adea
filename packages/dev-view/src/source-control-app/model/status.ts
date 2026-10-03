/*
 * Pull request status facets: reviews, checks, and branch. Each is a tone
 * plus a word — never a colour alone — and the inbox grouping and the merge
 * dock both read from these, so a row and its detail can never disagree.
 */
import type { GitHubCheckRollup } from '@adea-ai/types/dev-runtime'

import type { PullRequestView, Tone } from './types'

export type Facet = Readonly<{ tone: Tone; label: string; detail?: string }>

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

export function approvalCount(pr: PullRequestView): number {
  return pr.reviews.filter((review) => review.state === 'approved').length
}

export function changesRequested(pr: PullRequestView): boolean {
  return (
    pr.reviewDecision === 'changes_requested' ||
    pr.reviews.some((review) => review.state === 'changes_requested')
  )
}

/** Approvals are met when GitHub says approved, or when the repository
 *  requires no review (no decision) and nobody requested changes. */
export function approvalsMet(pr: PullRequestView): boolean {
  if (changesRequested(pr)) return false
  return pr.reviewDecision === 'approved' || pr.reviewDecision === undefined
}

export function checksPassing(checks: GitHubCheckRollup): boolean {
  return checks.state === 'success' || checks.state === 'none'
}

export function checksFailing(checks: GitHubCheckRollup): boolean {
  return checks.state === 'failure' || checks.failing > 0
}

export function hasConflicts(pr: PullRequestView): boolean {
  return pr.mergeable === 'conflicting' || pr.mergeState === 'dirty'
}

export function isBehind(pr: PullRequestView): boolean {
  return (pr.behindBy ?? 0) > 0 || pr.mergeState === 'behind'
}

export function viewerIsRequested(pr: PullRequestView, viewer: string | undefined): boolean {
  if (!viewer) return false
  return pr.requestedReviewers.some(
    (reviewer) => reviewer.kind !== 'team' && sameLogin(reviewer.login, viewer)
  )
}

export function viewerReviewedHead(pr: PullRequestView, viewer: string | undefined): boolean {
  if (!viewer) return false
  return pr.reviews.some(
    (review) =>
      sameLogin(review.actor.login, viewer) &&
      review.commitSha === pr.headSha &&
      review.state !== 'pending' &&
      review.state !== 'dismissed'
  )
}

export function viewerIsAuthor(pr: PullRequestView, viewer: string | undefined): boolean {
  return Boolean(viewer && pr.author && sameLogin(pr.author.login, viewer))
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

export function checksFacet(checks: GitHubCheckRollup): Facet {
  if (checks.total === 0 && checks.state === 'none') return { tone: 'neutral', label: 'No checks' }
  if (checksFailing(checks))
    return {
      tone: 'danger',
      label: `${checks.failing.toLocaleString('en-US')} of ${checks.total.toLocaleString('en-US')} failing`,
    }
  if (checks.running > 0 || checks.state === 'pending')
    return {
      tone: 'info',
      label:
        checks.running > 0
          ? `${checks.passing.toLocaleString('en-US')} passing, ${checks.running.toLocaleString('en-US')} running`
          : 'Checks pending',
    }
  return {
    tone: 'success',
    label:
      checks.total > 0
        ? `${checks.passing.toLocaleString('en-US')} of ${checks.total.toLocaleString('en-US')} passing`
        : 'Checks passing',
  }
}

export function reviewFacet(pr: PullRequestView): Facet {
  const approvals = approvalCount(pr)
  if (changesRequested(pr)) return { tone: 'danger', label: 'Changes requested' }
  if (pr.reviewDecision === 'approved')
    return { tone: 'success', label: approvals > 0 ? `Approved by ${approvals}` : 'Approved' }
  if (pr.reviewDecision === 'review_required')
    return {
      tone: 'warning',
      label: approvals > 0 ? `${plural(approvals, 'approval')}, more required` : 'Review required',
    }
  if (pr.requestedReviewers.length > 0) return { tone: 'warning', label: 'Review requested' }
  if (approvals > 0) return { tone: 'success', label: `Approved by ${approvals}` }
  return { tone: 'neutral', label: 'Not requested' }
}

export function branchFacet(pr: PullRequestView): Facet {
  if (hasConflicts(pr)) return { tone: 'danger', label: 'Conflicts with base' }
  if (isBehind(pr))
    return {
      tone: 'warning',
      label:
        pr.behindBy !== undefined && pr.behindBy > 0
          ? `${plural(pr.behindBy, 'commit')} behind ${pr.baseRef}`
          : `Behind ${pr.baseRef}`,
    }
  if (pr.mergeable === 'unknown') return { tone: 'unknown', label: 'Checking mergeability' }
  return { tone: 'success', label: `Up to date with ${pr.baseRef}` }
}
