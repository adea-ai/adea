// Git facts the worktree cleanup preflight observes: porcelain classification
// (only unmerged pairs are conflicts), the no-upstream unpushed count (argv
// split, unknown on failure), and the checkout repository's common dir for
// the post-prune registration check.
import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parsePorcelainStatus, repoCommonDirFor } from '../shell/src/dev-runtime/worktrees/service'
import { computeCleanupBlockers } from '../shell/src/dev-runtime/worktrees/cleanup-plan'
import { git, projectIdA, scope, fixture } from './worktree-fixtures'

describe('porcelain status classification', () => {
  test('every unmerged pair is a conflict', () => {
    for (const pair of ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']) {
      expect(parsePorcelainStatus(`${pair} file.txt\n`)).toEqual({
        conflicted: true,
        dirty: false,
        untracked: false,
      })
    }
  })

  test('staged adds, deletes, and other changes are dirty, not conflicted', () => {
    for (const line of [
      'A  added.txt',
      'D  gone.txt',
      'AM both.txt',
      ' M edited.txt',
      'R  a -> b',
    ]) {
      expect(parsePorcelainStatus(`${line}\n`)).toEqual({
        conflicted: false,
        dirty: true,
        untracked: false,
      })
    }
  })

  test('untracked entries are untracked only; empty output is clean', () => {
    expect(parsePorcelainStatus('?? new.txt\n')).toEqual({
      conflicted: false,
      dirty: false,
      untracked: true,
    })
    expect(parsePorcelainStatus('')).toEqual({ conflicted: false, dirty: false, untracked: false })
  })
})

describe('repository common dir', () => {
  test('a bare managed repository is its own common dir; a checkout uses .git', () => {
    expect(repoCommonDirFor({ canonicalRoot: '/r/bare', layout: 'bare_managed' })).toBe('/r/bare')
    expect(repoCommonDirFor({ canonicalRoot: '/r/checkout' })).toBe('/r/checkout/.git')
  })
})

async function createdWorktree(f: ReturnType<typeof fixture>) {
  const repo = await f.registerRepo()
  const created = await f.service.createWorktree({
    scope,
    repoId: repo.id,
    projectId: projectIdA,
    baseRef: 'main',
    worktreeBaseDir: f.workspace,
  })
  const worktree = created.worktree
  const lease = f.service.leases.list(worktree.id)[0]!
  f.service.leases.release({ scope, worktreeId: worktree.id, leaseId: lease.lease.id })
  return worktree
}

describe('no-upstream unpushed commits', () => {
  test('counts the commits no remote ref contains', async () => {
    const f = fixture()
    try {
      // A remote-tracking ref for main: only the worktree's own commit is unpushed.
      git(f.repoPath, ['update-ref', 'refs/remotes/origin/main', 'main'])
      const worktree = await createdWorktree(f)
      writeFileSync(join(worktree.canonicalRoot, 'work.txt'), 'local work\n')
      git(worktree.canonicalRoot, ['add', '.'])
      git(worktree.canonicalRoot, ['commit', '-q', '-m', 'local'])
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['quarantine_worktree'],
      })
      expect(plan.facts.upstreamKnown).toBe(false)
      expect(plan.facts.unpushedCommits).toBe(1)
    } finally {
      f.cleanup()
    }
  })

  test('an unmeasurable count is unknown (null), never zero', async () => {
    const f = fixture()
    try {
      const worktree = await createdWorktree(f)
      // The recorded branch no longer resolves, so rev-list fails.
      git(f.repoPath, ['update-ref', '-d', worktree.branchRef!])
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['quarantine_worktree'],
      })
      expect(plan.facts.unpushedCommits).toBeNull()
      expect(plan.blockers.map((blocker) => blocker.code)).toContain('unpushed')
    } finally {
      f.cleanup()
    }
  })

  test('an unknown count blocks even when the upstream comparison is clean', () => {
    const blockers = computeCleanupBlockers({
      worktreeId: 'w',
      generation: 1,
      provenance: 'adea',
      lifecycle: 'ready',
      canonicalRoot: '/w',
      repoPath: '/r',
      dirty: false,
      untracked: false,
      conflicted: false,
      upstreamKnown: true,
      ahead: 0,
      behind: 0,
      unpushedCommits: null,
      isDefaultBranch: false,
      isProtectedBranch: false,
      hasLiveLeases: false,
      attachedOwnedResources: [],
      nestedWorktrees: [],
      identityProven: true,
      gitdirProven: true,
      dangerous: false,
      trashRootUsable: true,
    })
    expect(blockers.map((blocker) => blocker.code)).toEqual(['unpushed'])
  })
})

describe('checkout repository prune verification', () => {
  test('a registration entry that survives the prune fails the unregister step', async () => {
    const f = fixture()
    try {
      const worktree = await createdWorktree(f)
      git(f.repoPath, ['branch', '--set-upstream-to=main', `adea/${worktree.name}`])
      const adminDir = join(f.repoPath, '.git', 'worktrees')
      // Unregister without quarantine: the checkout still exists, so
      // `git worktree prune` keeps its entry under `<repo>/.git/worktrees`.
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['unregister_worktree'],
      })
      expect(plan.blockers).toHaveLength(0)
      const outcome = await f.service.commitCleanup({ scope, plan, digest: plan.digest }).then(
        (result) => ({ state: result.state as string, code: '' }),
        (error: { code?: string }) => ({ state: 'rejected', code: error.code ?? '' })
      )
      expect(outcome).not.toMatchObject({ state: 'completed' })
      expect(existsSync(adminDir)).toBe(true)
      expect(
        git(f.repoPath, ['worktree', 'list', '--porcelain']).stdout.includes(worktree.canonicalRoot)
      ).toBe(true)
      expect(f.service.getWorktree(scope, worktree.id).lifecycle).not.toBe('cleaned')
    } finally {
      f.cleanup()
    }
  })
})
