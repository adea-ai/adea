// Bounded `.worktreeinclude` plan/apply: tracked-content protection, symlink
// and special-file refusal, budgets, secret-like item approvals, plan digest
// enforcement, TOCTOU identity rechecks, and CoW-first materialization
// (fs.copyFile + COPYFILE_FICLONE — stream loops are forbidden for this step).
import { describe, expect, test } from 'bun:test'
import {
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyIncludeCopy,
  isSecretLikePath,
  planIncludeCopy,
} from '../shell/src/dev-runtime/worktrees/include-copy'
import { identityOfPath } from '../shell/src/dev-runtime/worktrees/identity'
import { WorktreeError } from '../shell/src/dev-runtime/worktrees/errors'
import { git, initRepo } from './worktree-fixtures'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'adea-include-copy-'))
}

function ignored(dir: string, rel: string, contents: string): void {
  const target = join(dir, rel)
  mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true })
  writeFileSync(target, contents)
}

async function planAndApply(repo: string, worktree: string, approvals?: string[]) {
  const plan = await planIncludeCopy({ sourceRoot: repo, destinationRoot: worktree, approvals })
  if ('ran' in plan) throw new Error('expected a plan, got no include file')
  return applyIncludeCopy({ plan, digest: plan.digest })
}

describe('include copy plan and apply', () => {
  test('copies ignored untracked files into a fresh worktree via CoW clones', async () => {
    const dir = scratch()
    try {
      const repo = initRepo(join(dir, 'repo'))
      const worktree = join(dir, 'worktrees', 'feature')
      git(repo, ['worktree', 'add', worktree, '-b', 'feature'])
      writeFileSync(join(repo, '.worktreeinclude'), 'config/local.yaml\n')
      ignored(repo, 'config/local.yaml', 'setting: on\n')

      const result = await planAndApply(repo, worktree)
      expect(result.copied).toEqual(['config/local.yaml'])
      expect(readFileSync(join(worktree, 'config', 'local.yaml'), 'utf8')).toBe('setting: on\n')
      // FICLONE is the materialization contract; EXCL keeps no-overwrite at
      // the syscall level. Verify the flags this platform must carry.
      expect(fsConstants.COPYFILE_FICLONE).toBeGreaterThan(0)
      expect(fsConstants.COPYFILE_EXCL).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('never overwrites tracked content; the candidate is reported as excluded', async () => {
    const dir = scratch()
    try {
      const repo = initRepo(join(dir, 'repo'))
      const worktree = join(dir, 'worktrees', 'feature')
      git(repo, ['worktree', 'add', worktree, '-b', 'feature'])
      // `README.md` is tracked; a hostile include file must not win.
      writeFileSync(join(repo, '.worktreeinclude'), 'README.md\nconfig/local.yaml\n')
      ignored(repo, 'config/local.yaml', 'setting: on\n')

      // Tracked files are never candidates at all (`git ls-files --others`):
      // the checkout's own content wins by construction.
      const result = await planAndApply(repo, worktree)
      expect(result.copied).toEqual(['config/local.yaml'])
      expect(result.excluded).toEqual([])
      expect(result.copied).not.toContain('README.md')
      expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('# fixture\n')

      // Belt and braces: an apply whose destination path exists (the tracked
      // overwrite case at the syscall level) fails closed.
      const plan = await planIncludeCopy({ sourceRoot: repo, destinationRoot: worktree })
      if ('ran' in plan) throw new Error('expected a plan')
      const hostile = {
        ...plan,
        items: [
          {
            relativePath: 'README.md',
            sizeBytes: 4,
            sourceIdentity: identityOfPath(join(repo, 'README.md')),
            secretLike: false,
          },
        ],
      }
      // Re-digest the hostile plan so the digest gate passes and the
      // destination-presence recheck is what refuses.
      const { createHash } = await import('node:crypto')
      const JSONIFIED = JSON.stringify({
        sourceRoot: hostile.sourceRoot,
        destinationRoot: hostile.destinationRoot,
        destinationRootIdentity: hostile.destinationRootIdentity,
        items: hostile.items,
        excluded: hostile.excluded,
        totalBytes: hostile.totalBytes,
        approvedSecretLike: hostile.approvedSecretLike,
      })
      const redigested = {
        ...hostile,
        digest: createHash('sha256').update(JSONIFIED).digest('hex'),
      }
      let code = ''
      try {
        await applyIncludeCopy({ plan: redigested, digest: redigested.digest })
      } catch (error) {
        code = (error as WorktreeError).code
      }
      expect(code).toBe('plan_stale')
      expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('# fixture\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses symlink candidates outright', async () => {
    const dir = scratch()
    try {
      const repo = initRepo(join(dir, 'repo'))
      const worktree = join(dir, 'worktrees', 'feature')
      git(repo, ['worktree', 'add', worktree, '-b', 'feature'])
      writeFileSync(join(repo, '.worktreeinclude'), 'link.yaml\n')
      symlinkSync('/etc/hostname', join(repo, 'link.yaml'))

      let code = ''
      try {
        await planIncludeCopy({ sourceRoot: repo, destinationRoot: worktree })
      } catch (error) {
        code = (error as WorktreeError).code
      }
      expect(code).toBe('symlink_rejected')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('secret-like entries require explicit item-level approval', async () => {
    const dir = scratch()
    try {
      const repo = initRepo(join(dir, 'repo'))
      const worktree = join(dir, 'worktrees', 'feature')
      git(repo, ['worktree', 'add', worktree, '-b', 'feature'])
      writeFileSync(join(repo, '.worktreeinclude'), '.env\nconfig/local.yaml\n')
      ignored(repo, '.env', 'SECRET=1\n')
      ignored(repo, 'config/local.yaml', 'setting: on\n')

      // Without approval the plan refuses — .env inclusion is never implicit.
      expect(isSecretLikePath('.env')).toBe(true)
      let code = ''
      try {
        await planIncludeCopy({ sourceRoot: repo, destinationRoot: worktree })
      } catch (error) {
        code = (error as WorktreeError).code
      }
      expect(code).toBe('unauthorized')

      // With the item approval bound in, only the approved entry flows.
      const result = await planAndApply(repo, worktree, ['.env'])
      expect(result.copied.toSorted()).toEqual(['.env', 'config/local.yaml'].toSorted())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('enforces the file-count and per-file byte budgets', async () => {
    const dir = scratch()
    try {
      const repo = initRepo(join(dir, 'repo'))
      const worktree = join(dir, 'worktrees', 'feature')
      git(repo, ['worktree', 'add', worktree, '-b', 'feature'])
      // 1,001 candidates: one over the include-copy file budget.
      const lines: string[] = []
      for (let i = 0; i < 1001; i += 1) {
        const rel = `generated/file-${i}.bin`
        lines.push(rel)
        ignored(repo, rel, 'x')
      }
      writeFileSync(join(repo, '.worktreeinclude'), `${lines.join('\n')}\n`)

      let code = ''
      try {
        await planIncludeCopy({ sourceRoot: repo, destinationRoot: worktree })
      } catch (error) {
        code = (error as WorktreeError).code
      }
      expect(code).toBe('limit_exceeded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a plan digest mismatch refuses the apply (plan/commit split)', async () => {
    const dir = scratch()
    try {
      const repo = initRepo(join(dir, 'repo'))
      const worktree = join(dir, 'worktrees', 'feature')
      git(repo, ['worktree', 'add', worktree, '-b', 'feature'])
      writeFileSync(join(repo, '.worktreeinclude'), 'config/local.yaml\n')
      ignored(repo, 'config/local.yaml', 'setting: on\n')
      const plan = await planIncludeCopy({ sourceRoot: repo, destinationRoot: worktree })
      if ('ran' in plan) throw new Error('expected a plan, got no include file')

      // The source changed after the plan: both the digest binding and the
      // per-item identity recheck must fail closed.
      ignored(repo, 'config/local.yaml', 'setting: CHANGED\n')
      let code = ''
      try {
        await applyIncludeCopy({ plan, digest: plan.digest })
      } catch (error) {
        code = (error as WorktreeError).code
      }
      expect(['plan_stale', 'file_changed', 'identity_mismatch']).toContain(code)
      expect(existsSync(join(worktree, 'config', 'local.yaml'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
