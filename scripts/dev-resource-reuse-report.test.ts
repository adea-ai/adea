import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ELIGIBILITY, REUSE_DECISION, REUSE_REFUSAL } from './dev-resource-reuse.mjs'
import {
  collectReport,
  parseIgnoredPaths,
  planWorktrees,
  readLeaseEvidence,
  worktreesOf,
} from './dev-resource-reuse-report.mjs'

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

/**
 * The acquisition boundary, against controlled repositories and lease records.
 *
 * These tests read real Git output and real directories, because the failures
 * that matter here are failures of the reads: a status that hides untracked
 * work, a remote-tracking ref that outlives its branch, a lease record that
 * cannot be read, and a directory whose name says nothing about what it holds.
 */
const scratch: string[] = []

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

/** A repository with one linked checkout, and the root that holds them. */
function tempRepo(name: string, { ignore = [] as string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), `adea-reuse-${name}-`))
  scratch.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(['init', '--initial-branch=main'], repo)
  git(['config', 'user.email', 'test@example.invalid'], repo)
  git(['config', 'user.name', 'Test'], repo)
  writeFileSync(join(repo, 'file.txt'), 'base\n')
  // The tracked producers: the lockfile pins the dependency tree, and the
  // package manifest declares the build.
  writeFileSync(join(repo, 'bun.lock'), '{}\n')
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'case', private: true, scripts: { build: 'true' } })
  )
  writeFileSync(join(repo, '.gitignore'), `${ignore.join('\n')}\n`)
  git(['add', '.'], repo)
  git(['commit', '-m', 'base'], repo)
  const checkout = join(root, 'checkout')
  git(['worktree', 'add', '-b', 'feature/case', checkout], repo)
  return { root, repo, checkout }
}

afterAll(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the runner reads the checkout it is given', () => {
  test('untracked work is listed even when the repository hides it', () => {
    const { repo, checkout } = tempRepo('untracked')
    // The repository turns the untracked listing off, the way a developer who
    // wants a quiet status does. The runner asks for the files anyway.
    git(['config', 'status.showUntrackedFiles', 'no'], repo)
    writeFileSync(join(checkout, 'notes.txt'), 'uncommitted\n')

    const { worktrees } = worktreesOf(repo, { refresh: false })
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0]?.localChanges).toBe(true)
  })

  test('a remote-tracking ref the remote does not hold is not authority', () => {
    const { root, repo } = tempRepo('stale-remote')
    const remote = join(root, 'remote.git')
    git(['init', '--bare', remote], root)
    git(['remote', 'add', 'origin', remote], repo)
    git(['push', 'origin', 'main'], repo)
    git(['push', 'origin', 'feature/case'], repo)
    // The branch is removed on the remote, and the local remote-tracking ref is
    // left behind: a fetch that does not prune keeps it.
    git(['--git-dir', remote, 'update-ref', '-d', 'refs/heads/feature/case'], root)
    git(['fetch', 'origin'], repo)
    const tracking = git(['rev-parse', '--verify', 'refs/remotes/origin/feature/case'], repo)
    expect(tracking).not.toBe('')

    const { worktrees, fetch } = worktreesOf(repo, { refresh: true })
    expect(fetch.ok).toBe(true)
    expect(worktrees[0]?.origin?.remoteBranchPresent).toBe(false)
    expect(worktrees[0]?.origin?.fresh).toBe(false)
  })

  test('local persisted state is preserved, and a proven build output is not', () => {
    const { repo, checkout } = tempRepo('ignored', {
      ignore: ['node_modules/', 'dist/', '.wrangler/'],
    })
    mkdirSync(join(checkout, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(checkout, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    mkdirSync(join(checkout, 'dist'), { recursive: true })
    writeFileSync(join(checkout, 'dist', 'bundle.js'), 'built\n')
    mkdirSync(join(checkout, '.wrangler', 'state'), { recursive: true })
    writeFileSync(join(checkout, '.wrangler', 'state', 'v3.sqlite'), 'persisted\n')

    const { worktrees } = worktreesOf(repo, { refresh: false })
    const unknown = worktrees[0]?.ignoredUnknown ?? []
    // The dependency tree and the build output have tracked producers, so they
    // are regenerable. The local persisted state has none, so it is content.
    expect(unknown).not.toContain('node_modules/')
    expect(unknown).not.toContain('dist/')
    expect(unknown).toContain('.wrangler/')
  })

  test('a checkout whose ignored paths cannot be read is not free', () => {
    const { repo } = tempRepo('unreadable-ignored')
    const { worktrees } = worktreesOf(repo, { refresh: false })
    // The ignored list of an empty checkout reads as empty; the planner refuses
    // an unreadable one, which the runner reports as such.
    const [planned] = planWorktrees([{ ...worktrees[0], ignoredUnreadable: true }], [])
    expect(planned?.plan.decision).toBe(REUSE_DECISION.refuse)
    expect(planned?.plan.reasons).toContain(REUSE_REFUSAL.unreadableIgnored)
  })
})

describe('the lease records that could not be read', () => {
  test('a record that does not parse is named, not discarded', () => {
    const { root } = tempRepo('lease-unreadable')
    const leases = join(root, 'leases')
    mkdirSync(leases)
    writeFileSync(join(leases, 'broken.json'), '{not json')

    const evidence = readLeaseEvidence(leases)
    expect(evidence.unreadable).toEqual(['broken.json'])
    expect(evidence.leases).toEqual([])
    expect(evidence.scanError).toBeNull()
  })

  test('a record that is not yet valid is evidence of an unknown owner', () => {
    const { root } = tempRepo('lease-future')
    const leases = join(root, 'leases')
    mkdirSync(leases)
    const ahead = Date.now() + 86_400_000
    writeFileSync(
      join(leases, 'future.json'),
      JSON.stringify({
        version: 1,
        runId: 'run-future',
        mode: 'disposable',
        identity: { label: 'l', project: 'p', worktree: '/tmp/future' },
        owner: { pid: 4242, hostname: 'host-a', startedAt: '2026-10-21T00:00:00.000Z' },
        state: 'claimed',
        createdAt: ahead,
        updatedAt: ahead,
        cleanup: null,
      })
    )

    const evidence = readLeaseEvidence(leases)
    expect(evidence.future).toEqual(['run-future'])
  })

  test('a lease directory that cannot be read protects everything', () => {
    const { root, repo } = tempRepo('lease-scan')
    const notADirectory = join(root, 'leases')
    writeFileSync(notADirectory, 'not a directory\n')

    const evidence = readLeaseEvidence(notADirectory)
    expect(evidence.scanError).not.toBeNull()

    const { report } = collectReport({
      repo,
      leaseDir: notADirectory,
      now: '2026-10-22T00:00:00.000Z',
    })
    expect(report.leaseScanError).not.toBeNull()
    // The checkout cannot be freed: the ownership behind it is unknown.
    expect(report.worktrees[0]?.eligibility).toBe(ELIGIBILITY.ineligible)
    expect(report.worktrees[0]?.reasons).toContain(REUSE_REFUSAL.uncertainLeaseEvidence)
  })

  test('an unreadable record protects every checkout', () => {
    const { root, repo } = tempRepo('lease-protects')
    const leases = join(root, 'leases')
    mkdirSync(leases)
    writeFileSync(join(leases, 'broken.json'), '{not json')

    const { report } = collectReport({
      repo,
      leaseDir: leases,
      now: '2026-10-22T00:00:00.000Z',
    })
    expect(report.unreadableLeaseRecords).toEqual(['broken.json'])
    expect(report.worktrees[0]?.eligibility).toBe(ELIGIBILITY.ineligible)
    expect(report.worktrees[0]?.reasons).toContain(REUSE_REFUSAL.uncertainLeaseEvidence)
  })
})

describe('the command itself', () => {
  test('it writes a report, and it removes nothing', () => {
    const { root, repo } = tempRepo('cli')
    const leases = join(root, 'leases')
    mkdirSync(leases)
    const reportPath = join(root, 'report.json')

    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, 'dev-resource-reuse-report.mjs'),
        '--repo',
        repo,
        '--lease-dir',
        leases,
        '--report',
        reportPath,
      ],
      { encoding: 'utf8' }
    )
    expect(result.status).toBe(0)
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    expect(report.repository).toBe(repo)
    expect(report.preservation.ok).toBe(true)
    // The checkout holds an unreadable origin and no lease, so it is preserved.
    expect(report.worktrees[0]?.eligibility).toBe(ELIGIBILITY.ineligible)
    expect(report.summary.eligibleWorktrees).toBe(0)
    // The command wrote a report and nothing else: the checkout is still there.
    expect(report.worktrees).toHaveLength(1)
  })
})
