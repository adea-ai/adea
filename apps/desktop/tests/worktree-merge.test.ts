// Squash merge-back through a temporary detached worktree: success, conflict
// retention with recovery, moved-ref refusal, no-changes, CAS branch deletion.
// Donor semantics: bb `workspace.ts` squashMergeInto (MIT); hardened with
// durable recovery retention instead of the donor's finally-removal.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMergeService } from '../shell/src/dev-runtime/worktrees/merge'
import { WorktreeError } from '../shell/src/dev-runtime/worktrees/errors'
import { git, initRepo } from './worktree-fixtures'

const scratchRoots: string[] = []
afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adea-merge-'))
  scratchRoots.push(dir)
  return dir
}

/** A repo with a primary checkout on `main` and a linked worktree on
 *  `feature` carrying one commit. */
function mergeFixture(dir: string) {
  const repoPath = initRepo(join(dir, 'repo'))
  const worktreePath = join(dir, 'feature')
  git(repoPath, ['worktree', 'add', worktreePath, '-b', 'feature'])
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature work\n')
  git(worktreePath, ['add', '.'])
  git(worktreePath, ['commit', '-m', 'feature change'])
  const dataDir = join(dir, 'data')
  const service = createMergeService({ dataDir, tempRoot: join(dir, 'merge-temp') })
  return { repoPath, worktreePath, service }
}

describe('merge-back via temporary detached worktree', () => {
  test('squashes the feature branch into the target and removes the temp worktree', async () => {
    const dir = scratch()
    try {
      const { repoPath, worktreePath, service } = mergeFixture(dir)
      const plan = await service.planMerge({
        worktreeId: 'wt-1',
        worktreeRoot: worktreePath,
        repoPath,
        targetRef: 'refs/heads/main',
        commitMessage: 'Merge feature (squash)',
      })
      expect(plan.strategy).toBe('squash')
      expect(plan.sourceBranch).toBe('refs/heads/feature')

      const outcome = await service.commitMerge({ plan, digest: plan.digest })
      expect(outcome.state).toBe('merged')
      expect(outcome.publishedSha).toBeDefined()

      // The target advanced; the commit is on main and contains the work.
      const mainSha = git(repoPath, ['rev-parse', 'refs/heads/main']).stdout.trim()
      expect(mainSha).toBe(outcome.publishedSha)
      expect(git(repoPath, ['show', '--stat', mainSha]).stdout).toContain('feature.txt')
      // The temp worktree is gone and nothing extra is registered.
      expect(
        git(repoPath, ['worktree', 'list', '--porcelain']).stdout.match(/worktree /g)?.length
      ).toBe(2)
      // Idempotent replay: re-committing the same plan does not re-merge.
      const replay = await service.commitMerge({ plan, digest: plan.digest })
      expect(replay.state).toBe('merged')
      expect(replay.publishedSha).toBe(outcome.publishedSha)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a conflict retains the temp worktree, recovery token, and instructions', async () => {
    const dir = scratch()
    try {
      const { repoPath, worktreePath, service } = mergeFixture(dir)
      // Conflicting change on main.
      writeFileSync(join(repoPath, 'feature.txt'), 'conflicting main work\n')
      git(repoPath, ['add', '.'])
      git(repoPath, ['commit', '-m', 'main change'])

      const plan = await service.planMerge({
        worktreeId: 'wt-1',
        worktreeRoot: worktreePath,
        repoPath,
        targetRef: 'refs/heads/main',
        commitMessage: 'Merge feature (squash)',
      })
      const outcome = await service.commitMerge({ plan, digest: plan.digest })
      expect(outcome.state).toBe('conflicted')
      expect(outcome.recoveryToken).toBeDefined()
      expect(outcome.tempWorktreePath).toBeDefined()
      expect(outcome.instructions).toContain('Resolve')
      // Donor defect avoided: the temp worktree SURVIVES for resolution.
      expect(existsSync(outcome.tempWorktreePath!)).toBe(true)

      // Resolve and resume: the resolution publishes.
      writeFileSync(join(outcome.tempWorktreePath!, 'feature.txt'), 'resolved content\n')
      git(outcome.tempWorktreePath!, ['add', '.'])
      const resumed = await service.resumeMerge({
        recoveryToken: outcome.recoveryToken!,
        resolved: true,
      })
      expect(resumed.state).toBe('merged')
      expect(git(repoPath, ['show', '--stat', resumed.publishedSha!]).stdout).toContain(
        'feature.txt'
      )
      expect(existsSync(outcome.tempWorktreePath!)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an aborted conflict discards only the temporary worktree', async () => {
    const dir = scratch()
    try {
      const { repoPath, worktreePath, service } = mergeFixture(dir)
      writeFileSync(join(repoPath, 'feature.txt'), 'conflicting main work\n')
      git(repoPath, ['add', '.'])
      git(repoPath, ['commit', '-m', 'main change'])
      const plan = await service.planMerge({
        worktreeId: 'wt-1',
        worktreeRoot: worktreePath,
        repoPath,
        targetRef: 'refs/heads/main',
        commitMessage: 'x',
      })
      const outcome = await service.commitMerge({ plan, digest: plan.digest })
      expect(outcome.state).toBe('conflicted')
      const before = git(repoPath, ['rev-parse', 'refs/heads/main']).stdout.trim()
      const featureBefore = git(repoPath, ['rev-parse', 'refs/heads/feature']).stdout.trim()

      expect((await service.abortMerge(outcome.recoveryToken!)).aborted).toBe(true)
      expect(existsSync(outcome.tempWorktreePath!)).toBe(false)
      // Neither the target nor the source moved.
      expect(git(repoPath, ['rev-parse', 'refs/heads/main']).stdout.trim()).toBe(before)
      expect(git(repoPath, ['rev-parse', 'refs/heads/feature']).stdout.trim()).toBe(featureBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a moved target ref refuses at plan time and at commit time', async () => {
    const dir = scratch()
    try {
      const { repoPath, worktreePath, service } = mergeFixture(dir)
      const expected = git(repoPath, ['rev-parse', 'refs/heads/main']).stdout.trim()

      // Stale expectation at plan time.
      writeFileSync(join(repoPath, 'drift.txt'), 'x\n')
      git(repoPath, ['add', '.'])
      git(repoPath, ['commit', '-m', 'main moved'])
      let code = ''
      try {
        await service.planMerge({
          worktreeId: 'wt-1',
          worktreeRoot: worktreePath,
          repoPath,
          targetRef: 'refs/heads/main',
          expectedTargetSha: expected,
          commitMessage: 'x',
        })
      } catch (error) {
        code = (error as WorktreeError).code
      }
      expect(code).toBe('remote_changed')

      // Ref moves between plan and commit.
      const plan = await service.planMerge({
        worktreeId: 'wt-1',
        worktreeRoot: worktreePath,
        repoPath,
        targetRef: 'refs/heads/main',
        commitMessage: 'x',
      })
      writeFileSync(join(repoPath, 'drift2.txt'), 'y\n')
      git(repoPath, ['add', '.'])
      git(repoPath, ['commit', '-m', 'main moved again'])
      code = ''
      try {
        await service.commitMerge({ plan, digest: plan.digest })
      } catch (error) {
        code = (error as WorktreeError).code
      }
      expect(code).toBe('remote_changed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no changes is a consumed, non-error outcome', async () => {
    const dir = scratch()
    try {
      const repoPath = initRepo(join(dir, 'repo'))
      const worktreePath = join(dir, 'feature')
      git(repoPath, ['worktree', 'add', worktreePath, '-b', 'feature'])
      const service = createMergeService({
        dataDir: join(dir, 'data'),
        tempRoot: join(dir, 'merge-temp'),
      })
      const plan = await service.planMerge({
        worktreeId: 'wt-1',
        worktreeRoot: worktreePath,
        repoPath,
        targetRef: 'refs/heads/main',
        commitMessage: 'nothing',
      })
      const outcome = await service.commitMerge({ plan, digest: plan.digest })
      expect(outcome.state).toBe('no_changes')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('branch deletion is expected-SHA compare-and-swap', async () => {
    const dir = scratch()
    try {
      const repoPath = initRepo(join(dir, 'repo'))
      const service = createMergeService({ dataDir: join(dir, 'data') })
      const sha = git(repoPath, ['rev-parse', 'refs/heads/main']).stdout.trim()

      // Wrong expected SHA refuses.
      let code = ''
      try {
        await service.deleteBranchIfUnchanged({
          repoPath,
          branchRef: 'refs/heads/main',
          expectedSha: 'a'.repeat(40),
        })
      } catch (error) {
        code = (error as WorktreeError).code
      }
      expect(code).toBe('remote_changed')
      expect(git(repoPath, ['rev-parse', 'refs/heads/main']).code).toBe(0)

      // Correct SHA deletes exactly once.
      expect(
        (
          await service.deleteBranchIfUnchanged({
            repoPath,
            branchRef: 'refs/heads/main',
            expectedSha: sha,
          })
        ).deleted
      ).toBe(true)
      expect(git(repoPath, ['rev-parse', '--verify', 'refs/heads/main']).code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a tampered plan digest refuses the commit', async () => {
    const dir = scratch()
    try {
      const { repoPath, worktreePath, service } = mergeFixture(dir)
      const plan = await service.planMerge({
        worktreeId: 'wt-1',
        worktreeRoot: worktreePath,
        repoPath,
        targetRef: 'refs/heads/main',
        commitMessage: 'x',
      })
      let code = ''
      try {
        await service.commitMerge({ plan, digest: 'f'.repeat(64) })
      } catch (error) {
        code = (error as WorktreeError).code
      }
      expect(code).toBe('plan_stale')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
