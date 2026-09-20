/*
 * Remote source-control model (#423): pure presentation helpers for the
 * GitHub pane sections — PR/check state summaries, ahead/behind labels, and
 * the bounded plain-text treatment of untrusted provider content (PR bodies,
 * check names, error text). Pure data work, no transport.
 */
import type { GitHubCheck, GitHubPullRequest } from '@adea-ai/types/dev-runtime'

export type CheckSummary = Readonly<{
  total: number
  succeeded: number
  failed: number
  pending: number
  skipped: number
}>

/** Aggregate a checks page into the concise state the sidebar card shows. */
export function summarizeChecks(checks: readonly GitHubCheck[]): CheckSummary {
  let succeeded = 0
  let failed = 0
  let pending = 0
  let skipped = 0
  for (const check of checks) {
    if (check.status !== 'completed') {
      pending += 1
      continue
    }
    switch (check.conclusion) {
      case 'success':
      case 'neutral':
        succeeded += 1
        break
      case 'skipped':
        skipped += 1
        break
      case undefined:
        pending += 1
        break
      default:
        failed += 1
    }
  }
  return { total: checks.length, succeeded, failed, pending, skipped }
}

/** `3/4 checks` style summary line; empty when no checks exist. */
export function checksLabel(summary: CheckSummary): string {
  if (summary.total === 0) return 'no checks'
  const parts = [`${summary.succeeded}/${summary.total} checks`]
  if (summary.failed > 0) parts.push(`${summary.failed} failed`)
  if (summary.pending > 0) parts.push(`${summary.pending} pending`)
  return parts.join(', ')
}

export function pullRequestStateLabel(pr: Pick<GitHubPullRequest, 'state' | 'draft'>): string {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  return pr.draft ? 'draft' : 'open'
}

export function aheadBehindLabel(aheadBehind: { ahead: number; behind: number }): string {
  if (aheadBehind.ahead === 0 && aheadBehind.behind === 0) return 'up to date with base'
  const parts: string[] = []
  if (aheadBehind.ahead > 0) parts.push(`${aheadBehind.ahead} ahead`)
  if (aheadBehind.behind > 0) parts.push(`${aheadBehind.behind} behind`)
  return parts.join(', ') + ' base'
}

/** Human label for the review decision field; absent means no reviews yet. */
export function reviewDecisionLabel(
  decision: GitHubPullRequest['reviewDecision']
): string | undefined {
  switch (decision) {
    case 'approved':
      return 'approved'
    case 'changes_requested':
      return 'changes requested'
    case 'review_required':
      return 'review required'
    default:
      return undefined
  }
}

/** Untrusted provider content (PR titles/bodies, check names, error text) is
 *  bounded plain text: control characters are stripped and the length capped.
 *  The pane renders it through Solid text nodes, so it can never become HTML
 *  or a command — this helper only keeps it short and printable. */
export function truncateUntrusted(text: string, budget = 200): string {
  const printable = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return printable.length > budget ? `${printable.slice(0, budget - 1)}…` : printable
}
