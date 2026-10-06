/*
 * The merge dock: three status rows (reviews, checks, branch) and one action
 * row. The merge control is one of:
 *
 *   - merge_now        every row is green: merge after a confirmation;
 *   - merge_when_ready something is still pending and the repository allows
 *                      auto-merge: enable it for the chosen method;
 *   - auto_enabled     auto-merge is already on: show it with Cancel;
 *   - disabled         conflicts, requested changes, a draft, or a closed PR,
 *                      with the reason beside it.
 */
import type { GitHubMergeMethod } from '@adea-ai/types/dev-runtime'

import { displayLogin, shortSha } from './format'
import {
  approvalsMet,
  branchFacet,
  changesRequested,
  checksFacet,
  checksFailing,
  checksPassing,
  hasConflicts,
  isBehind,
  reviewFacet,
  viewerIsAuthor,
  viewerIsRequested,
  viewerReviewedHead,
  type Facet,
} from './status'
import type { ProviderCapabilities, PullRequestView } from './types'

export type MergeControl =
  | Readonly<{ kind: 'merge_now'; label: string; helper: string }>
  | Readonly<{ kind: 'merge_when_ready'; label: string; helper: string }>
  | Readonly<{ kind: 'auto_enabled'; label: string; helper: string }>
  | Readonly<{ kind: 'disabled'; label: string; helper: string }>

export type MergeDock = Readonly<{
  /** `summary` is the sentence beside the chip: who reviewed, whose review
   *  is still awaited, and whether that includes the viewer. */
  reviews: Facet & Readonly<{ canReview: boolean; summary: string }>
  /** `summary` names the head commit and the buckets the chip leaves out. */
  checks: Facet & Readonly<{ summary: string }>
  branch: Facet & Readonly<{ canUpdate: boolean }>
  merge: MergeControl
}>

export const mergeMethodLabel: Record<GitHubMergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
}

const mergeVerb: Record<GitHubMergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Merge',
  rebase: 'Rebase and merge',
}

/** The method to offer: the remembered choice when the repository still
 *  allows it, else squash, else whatever the repository allows first. */
export function preferredMethod(
  allowed: readonly GitHubMergeMethod[],
  remembered: GitHubMergeMethod | undefined
): GitHubMergeMethod | undefined {
  if (remembered && allowed.includes(remembered)) return remembered
  if (allowed.includes('squash')) return 'squash'
  return allowed[0]
}

export function mergeDock(
  pr: PullRequestView,
  viewer: string | undefined,
  method: GitHubMergeMethod | undefined,
  capabilities: ProviderCapabilities
): MergeDock {
  const conflicts = hasConflicts(pr)
  const behind = isBehind(pr)
  const reviews = {
    ...reviewFacet(pr),
    canReview: pr.state === 'open' && !viewerIsAuthor(pr, viewer),
    summary: reviewsSummary(pr, viewer),
  }
  const checks = { ...checksFacet(pr.checks), summary: checksSummary(pr) }
  const branch = {
    ...branchFacet(pr),
    canUpdate: capabilities.updateBranch && pr.state === 'open' && behind && !conflicts,
  }
  return {
    reviews,
    checks,
    branch,
    merge: mergeControl(pr, method, capabilities, conflicts, behind),
  }
}

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

/** "Your review is requested · dana approved · Waiting on rhea." The
 *  viewer's own pending request leads, because it is the one thing on the
 *  row the viewer can act on. */
export function reviewsSummary(pr: PullRequestView, viewer: string | undefined): string {
  const parts: string[] = []
  const viewerPending =
    pr.state === 'open' && viewerIsRequested(pr, viewer) && !viewerReviewedHead(pr, viewer)
  if (viewerPending) parts.push('Your review is requested')
  for (const review of pr.reviews) {
    if (review.state === 'approved') parts.push(`${displayLogin(review.actor.login)} approved`)
    else if (review.state === 'changes_requested')
      parts.push(`${displayLogin(review.actor.login)} requested changes`)
  }
  const waiting = pr.requestedReviewers.filter(
    (reviewer) => !(viewerPending && viewer && sameLogin(reviewer.login, viewer))
  )
  if (waiting.length > 0)
    parts.push(`Waiting on ${waiting.map((reviewer) => displayLogin(reviewer.login)).join(', ')}`)
  if (parts.length === 0) return pr.reviews.length > 0 ? 'No approvals yet.' : 'No reviews yet.'
  return `${parts.join(' · ')}.`
}

/** "Failing on a1b2c3d · 3 passing, 1 skipped." The chip already carries
 *  the headline counts; this names the commit and the rest. */
export function checksSummary(pr: PullRequestView): string {
  const checks = pr.checks
  const on = `on ${shortSha(pr.headSha)}`
  if (checks.total === 0 && checks.state === 'none') return `No checks reported ${on}.`
  const failing = checksFailing(checks)
  const running = !failing && (checks.running > 0 || checks.state === 'pending')
  const rest = [
    failing && checks.passing > 0 ? `${checks.passing.toLocaleString('en-US')} passing` : undefined,
    failing && checks.running > 0 ? `${checks.running.toLocaleString('en-US')} running` : undefined,
    checks.skipped > 0 ? `${checks.skipped.toLocaleString('en-US')} skipped` : undefined,
  ].filter((part): part is string => part !== undefined)
  const lead = failing ? 'Failing' : running ? 'Running' : 'Passed'
  return `${lead} ${on}${rest.length > 0 ? ` · ${rest.join(', ')}` : ''}.`
}

function mergeControl(
  pr: PullRequestView,
  method: GitHubMergeMethod | undefined,
  capabilities: ProviderCapabilities,
  conflicts: boolean,
  behind: boolean
): MergeControl {
  const verb = method ? mergeVerb[method] : 'Merge'
  if (pr.state === 'merged')
    return { kind: 'disabled', label: 'Merged', helper: 'This pull request is merged.' }
  if (pr.state === 'closed')
    return { kind: 'disabled', label: verb, helper: 'Reopen the pull request to merge it.' }
  if (method === undefined)
    return { kind: 'disabled', label: 'Merge', helper: 'The repository allows no merge method.' }
  if (pr.autoMerge)
    return {
      kind: 'auto_enabled',
      label: `${mergeVerb[pr.autoMerge.method]} when ready`,
      helper: pr.autoMerge.enabledBy
        ? `Enabled by ${pr.autoMerge.enabledBy}. It merges once every requirement is met.`
        : 'It merges once every requirement is met.',
    }
  if (pr.draft)
    return {
      kind: 'disabled',
      label: verb,
      helper: 'Mark the pull request ready for review first.',
    }
  if (conflicts)
    return { kind: 'disabled', label: verb, helper: 'Resolve the conflicts with the base first.' }
  if (changesRequested(pr))
    return { kind: 'disabled', label: verb, helper: 'A reviewer requested changes.' }
  if (checksFailing(pr.checks))
    return { kind: 'disabled', label: verb, helper: 'Fix the failing checks first.' }
  const ready = approvalsMet(pr) && checksPassing(pr.checks) && !behind
  if (ready) return { kind: 'merge_now', label: verb, helper: 'Every requirement is met.' }
  if (capabilities.autoMerge && pr.autoMergeAllowed)
    return {
      kind: 'merge_when_ready',
      label: `${verb} when ready`,
      helper: behind
        ? 'Update the branch; it then merges once approvals and checks are in.'
        : 'Merges on its own once approvals and checks are in.',
    }
  return {
    kind: 'disabled',
    label: verb,
    helper: behind ? 'Update the branch with its base first.' : 'Waiting on approvals or checks.',
  }
}
