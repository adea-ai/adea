import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ELIGIBILITY, REUSE_DECISION, REUSE_REFUSAL } from './dev-resource-reuse.mjs'
import {
  collectReport,
  originIsBound,
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
    // The head is still in a local tracking ref, and that is not publication:
    // the remote does not hold it.
    expect(worktrees[0]?.published).toBe(false)
    const [planned] = planWorktrees(worktrees, [])
    expect(planned?.plan.decision).toBe(REUSE_DECISION.refuse)
  })

  test('a stale tracking ref never makes a head published', () => {
    const { root, repo } = tempRepo('stale-tracking')
    const remote = join(root, 'remote.git')
    git(['init', '--bare', remote], root)
    git(['remote', 'add', 'origin', remote], repo)
    git(['push', 'origin', 'main'], repo)
    git(['push', 'origin', 'feature/case'], repo)
    // The remote loses every branch; the local tracking refs survive a fetch
    // that does not prune, so the checkout's head is still in a local ref.
    git(['--git-dir', remote, 'update-ref', '-d', 'refs/heads/feature/case'], root)
    git(['--git-dir', remote, 'update-ref', '-d', 'refs/heads/main'], root)
    git(['fetch', 'origin'], repo)
    expect(git(['ls-remote', '--heads', 'origin'], repo)).toBe('')

    const { worktrees } = worktreesOf(repo, { refresh: false })
    expect(worktrees[0]?.published).toBe(false)
    expect(worktrees[0]?.origin?.fresh).toBe(false)
    expect(worktrees[0]?.origin?.bound).toBe(false)
  })

  test('a remote that was rewritten away from the head is not publication', () => {
    const { root, repo } = tempRepo('rewritten-remote')
    const remote = join(root, 'remote.git')
    git(['init', '--bare', remote], root)
    git(['remote', 'add', 'origin', remote], repo)
    git(['push', 'origin', 'main'], repo)
    git(['push', 'origin', 'feature/case'], repo)
    git(['fetch', 'origin'], repo)
    // Another party rewrites the branch to a history that does not contain the
    // checkout's head.
    const other = join(root, 'other')
    git(['clone', remote, other], root)
    git(['config', 'user.email', 'other@example.invalid'], other)
    git(['config', 'user.name', 'Other'], other)
    git(['checkout', '-B', 'rewritten'], other)
    writeFileSync(join(other, 'b.txt'), 'b\n')
    git(['add', '.'], other)
    git(['commit', '-m', 'rewritten'], other)
    git(['push', '--force', 'origin', 'rewritten:feature/case'], other)

    // The runner's own fetch sees the rewrite, so the fetched ref is the
    // remote's commit and the checkout's head is not in it.
    const refreshed = worktreesOf(repo, { refresh: true })
    expect(refreshed.worktrees[0]?.origin?.fresh).toBe(true)
    expect(refreshed.worktrees[0]?.origin?.bound).toBe(true)
    expect(refreshed.worktrees[0]?.origin?.containsHead).toBe(false)
    expect(refreshed.worktrees[0]?.published).toBe(false)
    const [planned] = planWorktrees(refreshed.worktrees, [])
    expect(planned?.plan.decision).toBe(REUSE_DECISION.refuse)
    expect(planned?.plan.reasons).toContain(REUSE_REFUSAL.originStale)
  })

  test('the fetched ref speaks for the remote only while it is the remote commit', () => {
    expect(originIsBound('aaa', 'aaa')).toBe(true)
    // The remote moved after the fetch: the fetched ref is behind it.
    expect(originIsBound('bbb', 'aaa')).toBe(false)
    // The remote does not hold the branch at all.
    expect(originIsBound(null, 'aaa')).toBe(false)
    expect(originIsBound('', 'aaa')).toBe(false)
    expect(originIsBound('aaa', null)).toBe(false)
  })

  test('local persisted state is preserved, and a build output is preserved too', () => {
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
    // A path that looks like a build output is not reproducible on the
    // strength of its name or of the build script beside it. Nothing here is
    // proven reproducible, so every one of them is content the checkout holds.
    expect(unknown).toContain('node_modules/')
    expect(unknown).toContain('dist/')
    expect(unknown).toContain('.wrangler/')
    // The content is named and measured, not assumed: the digest is what a
    // rebuild would have to reproduce.
    const content = worktrees[0]?.ignoredContent?.['dist/']
    expect(content?.files).toBe(1)
    expect(content?.bytes).toBe(6)
    expect(content?.truncated).toBe(false)
    expect(typeof content?.digest).toBe('string')
    expect(content?.digest?.length).toBe(64)
  })

  test('unique bytes inside an ignored directory are content the checkout holds', () => {
    const { repo, checkout } = tempRepo('unique-ignored', { ignore: ['dist/'] })
    mkdirSync(join(checkout, 'dist'), { recursive: true })
    writeFileSync(join(checkout, 'dist', 'only-copy.json'), '{"verdict": "irreplaceable"}\n')

    const { worktrees } = worktreesOf(repo, { refresh: false })
    expect(worktrees[0]?.ignoredUnknown).toContain('dist/')
    const content = worktrees[0]?.ignoredContent?.['dist/']
    expect(content?.files).toBe(1)
    expect(content?.truncated).toBe(false)
    // The checkout is refused: the content is not proven reproducible.
    const [planned] = planWorktrees(worktrees, [])
    expect(planned?.plan.decision).toBe(REUSE_DECISION.refuse)
    expect(planned?.plan.reasons).toContain(REUSE_REFUSAL.unknownIgnored)
  })

  test('a no-op build and a typecheck-only package prove nothing', () => {
    // The fixture's own manifest declares a build that does nothing.
    const { repo, checkout } = tempRepo('noop-build', { ignore: ['dist/'] })
    mkdirSync(join(checkout, 'dist'), { recursive: true })
    writeFileSync(join(checkout, 'dist', 'bundle.js'), 'built\n')

    const { worktrees } = worktreesOf(repo, { refresh: false })
    expect(worktrees[0]?.ignoredUnknown).toContain('dist/')

    // A second manifest that declares only a typecheck: a type check emits
    // nothing, so it is not a producer of build output either.
    const typecheckOnly = tempRepo('typecheck-only', { ignore: ['dist/'] })
    writeFileSync(
      join(typecheckOnly.repo, 'package.json'),
      JSON.stringify({ name: 'case', private: true, scripts: { typecheck: 'tsc --noEmit' } })
    )
    git(['add', '.'], typecheckOnly.repo)
    git(['commit', '-qm', 'a typecheck that emits nothing'], typecheckOnly.repo)
    mkdirSync(join(typecheckOnly.checkout, 'dist'), { recursive: true })
    writeFileSync(join(typecheckOnly.checkout, 'dist', 'bundle.js'), 'built\n')

    const typechecked = worktreesOf(typecheckOnly.repo, { refresh: false })
    expect(typechecked.worktrees[0]?.ignoredUnknown).toContain('dist/')
  })

  test('an ignored path that holds nothing has nothing to reproduce', () => {
    const { repo, checkout } = tempRepo('empty-ignored', { ignore: ['dist/'] })
    mkdirSync(join(checkout, 'dist'), { recursive: true })

    const { worktrees } = worktreesOf(repo, { refresh: false })
    expect(worktrees[0]?.ignoredUnknown).not.toContain('dist/')
    expect(worktrees[0]?.ignoredProofs?.['dist/']?.kind).toBe('empty_content')
    expect(worktrees[0]?.ignoredContent?.['dist/']?.files).toBe(0)
  })

  test('a rebuild in an isolated copy that matches the bytes is a proof', () => {
    const { repo, checkout } = tempRepo('rebuilt', { ignore: ['dist/'] })
    mkdirSync(join(checkout, 'dist'), { recursive: true })
    writeFileSync(join(checkout, 'dist', 'bundle.js'), 'built\n')

    const { worktrees } = worktreesOf(repo, { refresh: false })
    const digest = worktrees[0]?.ignoredContent?.['dist/']?.digest
    expect(typeof digest).toBe('string')

    const rebuilt = worktreesOf(repo, {
      refresh: false,
      rebuildDigests: { 'dist/': digest },
    })
    expect(rebuilt.worktrees[0]?.ignoredUnknown).not.toContain('dist/')
    expect(rebuilt.worktrees[0]?.ignoredProofs?.['dist/']?.kind).toBe('content_match')
    // A rebuild that produced different bytes is not a proof.
    const different = worktreesOf(repo, {
      refresh: false,
      rebuildDigests: { 'dist/': 'not-the-digest' },
    })
    expect(different.worktrees[0]?.ignoredUnknown).toContain('dist/')
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
