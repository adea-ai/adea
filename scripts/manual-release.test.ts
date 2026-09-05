import { describe, expect, test } from 'bun:test'

import { createReleasePlan, parseCommitLog } from './manual-release-core.mjs'

const record = (hash: string, subject: string, body = '') =>
  `${hash}\u001f${subject}\u001f${body}\u001e`

describe('manual release preflight', () => {
  test('detects commits that can produce a Release Please version', () => {
    const commits = parseCommitLog(
      [
        record('a', 'docs: clarify setup'),
        record('b', 'feat(auth): add desktop sign-in'),
        record('c', 'chore: refresh generated files', 'Release-As: 0.6.0'),
      ].join('')
    )

    const plan = createReleasePlan({
      branch: 'main',
      commits,
      head: 'abc123',
      latestTag: 'v0.5.0',
      remoteHead: 'abc123',
      status: '',
    })

    expect(plan.action).toBe('release')
    expect(plan.releasableCommits.map((commit) => commit.hash)).toEqual(['b', 'c'])
  })

  test('stops before validation and dispatch when no releasable change exists', () => {
    const plan = createReleasePlan({
      branch: 'main',
      commits: parseCommitLog(record('a', 'docs: clarify setup')),
      head: 'abc123',
      latestTag: 'v0.5.0',
      remoteHead: 'abc123',
      status: '',
    })

    expect(plan).toEqual({
      action: 'noop',
      latestTag: 'v0.5.0',
      releasableCommits: [],
    })
  })

  test('fails closed for a dirty, off-main, or unsynchronized checkout', () => {
    const input = {
      branch: 'main',
      commits: parseCommitLog(record('a', 'fix: release-worthy change')),
      head: 'abc123',
      latestTag: 'v0.5.0',
      remoteHead: 'abc123',
      status: '',
    }

    expect(() => createReleasePlan({ ...input, status: ' M package.json' })).toThrow('clean')
    expect(() => createReleasePlan({ ...input, branch: 'feature' })).toThrow('main')
    expect(() => createReleasePlan({ ...input, remoteHead: 'def456' })).toThrow('origin/main')
  })
})
