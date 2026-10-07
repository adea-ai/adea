/*
 * Check run facts for the Checks tab: which runs have a log the provider can
 * serve, and the span of one commit's run for its subtitle. Pure; `now` is
 * injected for tests.
 */
import type { GitHubCheck } from '@adea-ai/types/dev-runtime'

import { duration, relativeTime } from './format'
import type { ScmProvider } from './types'

/** A GitHub Actions job's page: the only GitHub check whose log is served. */
const ACTIONS_JOB = /\/actions\/runs\/\d+\/job\/\d+(?:[/?#]|$)/

/** Whether the provider can serve this run's log. GitLab serves every
 *  finished job's trace; GitHub only finished Actions jobs, so a check from
 *  another app offers no log rather than a link that fails. */
export function hasCheckLog(check: GitHubCheck, provider: ScmProvider): boolean {
  if (check.status !== 'completed') return false
  if (provider === 'gitlab') return true
  return check.detailsUrl !== undefined && ACTIONS_JOB.test(check.detailsUrl)
}

/** "started 34 minutes ago · 6 min 12 s", or "started 4 minutes ago ·
 *  still running": from the earliest start across the commit's runs to the
 *  latest finish. Empty when no run reports a start. */
export function runTiming(checks: readonly GitHubCheck[], now: number): string {
  const starts = checks.flatMap((check) => (check.startedAt ? [check.startedAt] : []))
  if (starts.length === 0) return ''
  const first = starts.reduce((left, right) =>
    Date.parse(right) < Date.parse(left) ? right : left
  )
  const started = relativeTime(first, now)
  if (checks.some((check) => check.status !== 'completed'))
    return `started ${started} · still running`
  const ends = checks.flatMap((check) => (check.completedAt ? [check.completedAt] : []))
  const last = ends.reduce<string | undefined>(
    (left, right) => (left === undefined || Date.parse(right) > Date.parse(left) ? right : left),
    undefined
  )
  const span = duration(first, last)
  return span ? `started ${started} · ${span}` : `started ${started}`
}
