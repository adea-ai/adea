import { describe, expect, test } from 'bun:test'

import { REUSE_DECISION } from './dev-resource-reuse.mjs'
import { parseIgnoredPaths, planWorktrees } from './dev-resource-reuse-report.mjs'

/**
 * The runner-level regressions.
 *
 * The report is built from what the runner observed, so the facts the runner
 * collects have to reach the planner unchanged: a checkout the runner verified
 * as fresh must not be refused for a stale origin, and a checkout the runner
 * could not verify must be refused.
 */

const WORKTREE = {
  path: '/tmp/worktrees/runner-case',
  head: 'abc123',
  branch: 'codex/example',
  localChanges: false,
  published: true,
  ignoredUnknown: [],
  origin: { fresh: true, containsHead: true },
  sizeBytes: 1024,
}

describe('the report runner plans from what it observed', () => {
  test('a verified origin reaches the planner', () => {
    const [planned] = planWorktrees([WORKTREE], [])
    expect(planned?.plan.decision).toBe(REUSE_DECISION.reuse)
    expect(planned?.plan.evidence.originFresh).toBe(true)
    expect(planned?.plan.evidence.headInOrigin).toBe(true)
  })

  test('an origin the runner could not verify is refused', () => {
    const [planned] = planWorktrees(
      [{ ...WORKTREE, origin: { fresh: false, containsHead: false } }],
      []
    )
    expect(planned?.plan.decision).toBe(REUSE_DECISION.refuse)
    expect(planned?.plan.evidence.originFresh).toBe(false)
  })

  test('a checkout that holds an ignored artifact the runner read is refused', () => {
    const [planned] = planWorktrees(
      [{ ...WORKTREE, ignoredUnknown: ['docs/evals/calibration-verdicts/grader-verdicts.json'] }],
      []
    )
    expect(planned?.plan.decision).toBe(REUSE_DECISION.refuse)
    expect(planned?.plan.evidence.ignoredUnknown).toHaveLength(1)
  })

  test('a live owner the runner read refuses the checkout', () => {
    const lease = {
      version: 1,
      runId: 'run-live',
      mode: 'disposable',
      identity: { label: 'l', project: 'p', worktree: WORKTREE.path },
      owner: { pid: 4242, hostname: 'host', startedAt: '2026-10-21T00:00:00.000Z' },
      state: 'claimed',
      createdAt: 0,
      updatedAt: 0,
      cleanup: null,
    }
    const [planned] = planWorktrees([WORKTREE], [lease])
    expect(planned?.plan.decision).toBe(REUSE_DECISION.refuse)
    expect(planned?.plan.evidence.ownerLive).toBe(true)
  })
})

describe('reading the ignored paths of a checkout', () => {
  test('only the ignored entries are read as ignored paths', () => {
    const listing = [
      ' M scripts/dev-resource-reuse.mjs',
      '?? scripts/dev-resource-reuse-report.test.ts',
      '!! node_modules/',
      '!! apps/web/dist/',
      '!! docs/evals/calibration-verdicts/',
    ].join('\n')
    expect(parseIgnoredPaths(listing)).toEqual([
      'node_modules/',
      'apps/web/dist/',
      'docs/evals/calibration-verdicts/',
    ])
  })

  test('a dirty checkout is local work, not an unknown ignored artifact', () => {
    const listing = [' M scripts/dev-resource-reuse.mjs', '!! node_modules/'].join('\n')
    const ignored = parseIgnoredPaths(listing)
    expect(ignored).toEqual(['node_modules/'])
    expect(ignored).not.toContain('scripts/dev-resource-reuse.mjs')
  })
})
