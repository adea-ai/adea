// Worktree service integration over disposable repositories: create-from-
// updated-base (never touching the primary checkout), name/path collisions
// and retirement, external adoption, archive losslessness, lease-bound
// cleanup preflight/commit with journal recovery, and the fingerprint-gated
// refresh.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorktreeError } from '../shell/src/dev-runtime/worktrees/errors'
import { directoryIdentity } from '../shell/src/dev-runtime/worktrees/identity'
import { workflowDigest } from '../shell/src/dev-runtime/worktrees/bootstrap'
import { createCleanupJournal } from '../shell/src/dev-runtime/worktrees/journal'
import { git, initRepo, projectIdA, scope, fixture, approval } from './worktree-fixtures'

const scratchRoots: string[] = []
afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix = 'adea-service-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchRoots.push(dir)
  return dir
}

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as WorktreeError).code ?? ''
  }
  return ''
}

describe('repository registration', () => {
  test('registers a git repo through an authorized bookmark; folders register too', async () => {
    const f = fixture()
    try {
      const repo = await f.registerRepo()
      expect(repo.kind).toBe('git')
      expect(repo.canonicalRoot).toBe(f.repoPath)

      // A folder project registers as kind folder (registration, not create).
      const folder = join(f.workspace, 'notes')
      mkdirSync(folder)
      const bookmark = f.roots.mint({
        scope,
        label: 'Notes',
        kind: 'directory',
        absolutePath: folder,
        approval,
      })
      const folderRepo = await f.service.registerRepo({
        scope,
        projectId: projectIdA,
        absolutePath: folder,
        bookmarkId: bookmark.id,
      })
      expect(folderRepo.kind).toBe('folder')
    } finally {
      f.cleanup()
    }
  })

  test('a repo path outside the bookmark is unauthorized', async () => {
    const f = fixture()
    try {
      const outside = scratch('adea-outside-')
      const strayRepo = initRepo(join(outside, 'stray'))
      expect(
        await codeOf(() =>
          f.service.registerRepo({
            scope,
            projectId: projectIdA,
            absolutePath: strayRepo,
            bookmarkId: f.bookmarkId,
          })
        )
      ).toBe('unauthorized_root')
    } finally {
      f.cleanup()
    }
  })
})

describe('create worktree from an updated base', () => {
  test('happy path: isolated worktree + terminal lease, primary untouched', async () => {
    const f = fixture()
    try {
      const repo = await f.registerRepo()
      const primaryHead = git(f.repoPath, ['rev-parse', 'HEAD']).stdout.trim()
      const result = await f.service.createWorktree({
        scope,
        repoId: repo.id,
        projectId: projectIdA,
        baseRef: 'main',
        worktreeBaseDir: f.workspace,
        idempotencyKey: 'create-1',
      })
      expect(result.worktree.lifecycle).toBe('ready')
      expect(result.worktree.provenance).toBe('adea')
      expect(result.worktree.baseSha).toBe(primaryHead)
      expect(result.worktree.branchRef).toBe(`refs/heads/adea/${result.name}`)
      // Startup terminal lease exists.
      expect(f.service.leases.list(result.worktree.id)).toHaveLength(1)
      // The primary checkout was never touched.
      expect(git(f.repoPath, ['rev-parse', 'HEAD']).stdout.trim()).toBe(primaryHead)
      expect(git(f.repoPath, ['status', '--porcelain']).stdout.trim()).toBe('')
    } finally {
      f.cleanup()
    }
  })

  test('updateBase fetches the configured remote; the base carries the new commit', async () => {
    const dir = scratch('adea-service-remote-')
    try {
      // origin: bare; seed: clone that advances origin; primary: stale clone.
      const origin = join(dir, 'origin.git')
      git(dir, ['init', '--bare', '-b', 'main', origin])
      const seed = join(dir, 'seed')
      git(dir, ['clone', '-q', origin, seed])
      writeFileSync(join(seed, 'README.md'), '# fixture\n')
      git(seed, ['add', '.'])
      git(seed, ['commit', '-qm', 'initial'])
      git(seed, ['push', '-q', 'origin', 'main'])
      mkdirSync(join(dir, 'workspace'))
      const primary = join(dir, 'workspace', 'primary')
      git(dir, ['clone', '-q', origin, primary])
      git(primary, ['config', 'core.hooksPath', '/dev/null'])

      const f = fixture()
      const wsBookmark = f.roots.mint({
        scope,
        label: 'Remote workspace',
        kind: 'repository',
        absolutePath: join(dir, 'workspace'),
        approval,
      })
      const repo = await f.service.registerRepo({
        scope,
        projectId: projectIdA,
        absolutePath: primary,
        bookmarkId: wsBookmark.id,
        remote: 'origin',
      })

      // Advance origin from the seed clone; the primary knows nothing yet.
      writeFileSync(join(seed, 'upstream.txt'), 'new upstream commit\n')
      git(seed, ['add', '.'])
      git(seed, ['commit', '-qm', 'upstream work'])
      git(seed, ['push', '-q', 'origin', 'main'])
      const upstreamSha = git(seed, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim()

      const result = await f.service.createWorktree({
        scope,
        repoId: repo.id,
        projectId: projectIdA,
        baseRef: 'origin/main',
        worktreeBaseDir: join(dir, 'workspace'),
        updateBase: true,
      })
      expect(result.worktree.baseSha).toBe(upstreamSha)
      f.cleanup()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a failing remote fetch fails typed and creates nothing', async () => {
    const dir = scratch('adea-service-badremote-')
    try {
      const primary = initRepo(join(dir, 'workspace', 'primary'))
      const f = fixture()
      const wsBookmark = f.roots.mint({
        scope,
        label: 'WS',
        kind: 'repository',
        absolutePath: join(dir, 'workspace'),
        approval,
      })
      const repo = await f.service.registerRepo({
        scope,
        projectId: projectIdA,
        absolutePath: primary,
        bookmarkId: wsBookmark.id,
        remote: 'origin',
      })
      const code = await f.service
        .createWorktree({
          scope,
          repoId: repo.id,
          projectId: projectIdA,
          baseRef: 'origin/main',
          worktreeBaseDir: join(dir, 'workspace'),
          updateBase: true,
        })
        .then(
          () => '',
          (error) => (error as WorktreeError).code
        )
      expect(code).toBe('remote_unavailable')
      expect(f.service.listWorktrees({ scope, repoId: repo.id })).toHaveLength(0)
      f.cleanup()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an idempotency key prevents duplicate worktrees after a retry', async () => {
    const f = fixture()
    try {
      const repo = await f.registerRepo()
      const input = {
        scope,
        repoId: repo.id,
        projectId: projectIdA,
        baseRef: 'main',
        worktreeBaseDir: f.workspace,
        idempotencyKey: 'retry-safe',
      }
      const first = await f.service.createWorktree(input)
      const second = await f.service.createWorktree(input)
      expect(second.worktree.id).toBe(first.worktree.id)
      expect(f.service.listWorktrees({ scope, repoId: repo.id })).toHaveLength(1)
    } finally {
      f.cleanup()
    }
  })

  test('collisions: existing paths and branches refuse typed', async () => {
    const f = fixture()
    try {
      const repo = await f.registerRepo()
      // Path collision with an existing sibling.
      mkdirSync(join(f.workspace, 'take-my-name'))
      expect(
        await codeOf(() =>
          f.service.createWorktree({
            scope,
            repoId: repo.id,
            projectId: projectIdA,
            baseRef: 'main',
            worktreeBaseDir: f.workspace,
            destinationName: 'take-my-name',
          })
        )
      ).toBe('path_collision')
      rmSync(join(f.workspace, 'take-my-name'), { recursive: true, force: true })

      // Branch collision (retirement refusal is covered end-to-end in the
      // complete-and-clean suite: the cleaned name is retired and reuse
      // refuses with name_collision).
      git(f.repoPath, ['branch', 'adea/explicit'])
      expect(
        await codeOf(() =>
          f.service.createWorktree({
            scope,
            repoId: repo.id,
            projectId: projectIdA,
            baseRef: 'main',
            worktreeBaseDir: f.workspace,
            destinationName: 'explicit',
          })
        )
      ).toBe('name_collision')
    } finally {
      f.cleanup()
    }
  })

  test('an unauthorized base directory is refused before any mutation', async () => {
    const f = fixture()
    try {
      const repo = await f.registerRepo()
      const outside = scratch('adea-outside-')
      expect(
        await codeOf(() =>
          f.service.createWorktree({
            scope,
            repoId: repo.id,
            projectId: projectIdA,
            baseRef: 'main',
            worktreeBaseDir: outside,
          })
        )
      ).toBe('unauthorized_root')
    } finally {
      f.cleanup()
    }
  })
})

describe('adoption and archive', () => {
  test('adopts a proven external worktree; cleanup blocks on external ownership', async () => {
    const f = fixture()
    try {
      const repo = await f.registerRepo()
      const external = join(f.workspace, 'external-wt')
      git(f.repoPath, ['worktree', 'add', external, '-b', 'external-branch'])
      const adopted = await f.service.adoptWorktree({
        scope,
        repoId: repo.id,
        projectId: projectIdA,
        worktreePath: external,
      })
      expect(adopted.provenance).toBe('external')
      expect(adopted.lifecycle).toBe('ready')
      expect(adopted.branchRef).toBe('refs/heads/external-branch')

      // Archive is lossless.
      const archived = f.service.archiveWorktree({
        scope,
        worktreeId: adopted.id,
        expectedGeneration: adopted.generation,
      })
      expect(archived.archived).toBe(true)
      expect(existsSync(join(external, 'README.md'))).toBe(true)
      const restored = f.service.unarchiveWorktree({
        scope,
        worktreeId: adopted.id,
        expectedGeneration: archived.generation,
      })
      expect(restored.archived).toBe(false)

      // External worktrees can never enter managed deletion.
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: adopted.id,
        expectedGeneration: restored.generation,
        selectedSteps: [],
      })
      expect(plan.blockers.map((blocker) => blocker.code)).toContain('external_ownership')
    } finally {
      f.cleanup()
    }
  })

  test('fingerprint-gated refresh: no-op stays unchanged, external mutation rescans', async () => {
    const f = fixture()
    try {
      const repo = await f.registerRepo()
      await f.service.createWorktree({
        scope,
        repoId: repo.id,
        projectId: projectIdA,
        baseRef: 'main',
        worktreeBaseDir: f.workspace,
      })
      // The first explicit refresh absorbs the admin delta the creation
      // itself produced (the create-time refresh ran before `worktree add`).
      await f.service.refreshRepo({ scope, repoId: repo.id })
      // Consecutive no-op refreshes are no-ops: no rescan, no subprocess storm.
      expect((await f.service.refreshRepo({ scope, repoId: repo.id })).changed).toBe(false)
      expect((await f.service.refreshRepo({ scope, repoId: repo.id })).changed).toBe(false)

      // An out-of-band worktree changes the admin state → one rescan.
      git(f.repoPath, ['worktree', 'add', join(f.workspace, 'manual'), '-b', 'manual'])
      expect((await f.service.refreshRepo({ scope, repoId: repo.id })).changed).toBe(true)
    } finally {
      f.cleanup()
    }
  })
})

describe('bootstrap and failure retention', () => {
  test('a failed bootstrap leaves the worktree inspectable and retryable', async () => {
    const f = fixture()
    try {
      const repo = await f.registerRepo()
      const workflow = {
        id: 'wf',
        version: 1,
        steps: [
          { id: 'fail', argv: [process.execPath, '-e', 'process.exit(3)'] },
          { id: 'never', argv: [process.execPath, '-e', 'process.exit(0)'] },
        ],
      }
      const approvalRecord = {
        method: 'owner_dialog' as const,
        reference: 'consent',
        approvedAt: new Date().toISOString(),
        canonicalRepoRoot: (await f.registerRepo()).canonicalRoot,
        workflowDigest: workflowDigest(workflow),
        workflowVersion: 1,
        scope,
      }

      await expect(
        f.service.createWorktree({
          scope,
          repoId: repo.id,
          projectId: projectIdA,
          baseRef: 'main',
          worktreeBaseDir: f.workspace,
          bootstrapWorkflow: workflow,
          bootstrapApproval: approvalRecord,
        })
      ).rejects.toMatchObject({ code: 'bootstrap_failed' })

      // Exactly one record: failed, inspectable, never deleted.
      const records = f.service.listWorktrees({ scope, repoId: repo.id })
      expect(records).toHaveLength(1)
      const record = records[0]
      expect(record.lifecycle).toBe('failed')
      expect(record.failure).toContain('bootstrap failed')
      expect(existsSync(join(record.canonicalRoot, 'README.md'))).toBe(true)

      // Retry with a corrected workflow (same binding path) completes.
      const fixed = {
        ...workflow,
        steps: [{ id: 'ok', argv: [process.execPath, '-e', 'process.exit(0)'] }],
      }
      approvalRecord.workflowDigest = workflowDigest(fixed)
      f.service.bindBootstrap({ worktreeId: record.id, workflow: fixed, approval: approvalRecord })
      const retried = await f.service.retryBootstrap({ scope, worktreeId: record.id })
      expect(retried.lifecycle).toBe('ready')
      expect(retried.bootstrap.state).toBe('completed')
    } finally {
      f.cleanup()
    }
  })
})

async function cleanWorktree(f: Awaited<ReturnType<typeof fixture>>) {
  const repo = await f.registerRepo()
  const created = await f.service.createWorktree({
    scope,
    repoId: repo.id,
    projectId: projectIdA,
    baseRef: 'main',
    worktreeBaseDir: f.workspace,
  })
  const worktree = created.worktree
  // Clean and "pushed": the branch sits at the same commit as its upstream,
  // so ahead/behind are zero and push state is known.
  git(f.repoPath, ['branch', '--set-upstream-to=main', `adea/${worktree.name}`])
  // Release the startup terminal lease so no live leases remain.
  const lease = f.service.leases.list(worktree.id)[0]
  f.service.leases.release({ scope, worktreeId: worktree.id, leaseId: lease.lease.id })
  return { repo, worktree }
}

describe('complete-and-clean', () => {
  test('preflight blocks destructive plans on unpushed and leased state', async () => {
    const f = fixture()
    try {
      const repo = await f.registerRepo()
      const created = await f.service.createWorktree({
        scope,
        repoId: repo.id,
        projectId: projectIdA,
        baseRef: 'main',
        worktreeBaseDir: f.workspace,
      })
      const worktree = created.worktree

      // Unpushed commits (no upstream) and the live startup lease both block.
      writeFileSync(join(worktree.canonicalRoot, 'work.txt'), 'local work\n')
      git(worktree.canonicalRoot, ['add', '.'])
      git(worktree.canonicalRoot, ['commit', '-m', 'local'])
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['quarantine_worktree'],
      })
      expect(plan.blockers.map((blocker) => blocker.code)).toContain('unpushed')
      expect(plan.blockers.map((blocker) => blocker.code)).toContain('leased')

      // Dirty state: the plan carries the blocker so the UI can show exactly
      // what refuses destructive steps.
      writeFileSync(join(worktree.canonicalRoot, 'dirty.txt'), 'dirty\n')
      const dirtyPlan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['quarantine_worktree'],
      })
      expect(dirtyPlan.blockers.map((blocker) => blocker.code)).toContain('dirty')
    } finally {
      f.cleanup()
    }
  })

  test('complete-and-clean executes proven steps, retires the name, and cleans', async () => {
    const f = fixture()
    try {
      const { repo, worktree } = await cleanWorktree(f)
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['quarantine_worktree', 'unregister_worktree', 'delete_quarantine'],
      })
      expect(plan.blockers).toHaveLength(0)
      const result = await f.service.commitCleanup({ scope, plan, digest: plan.digest })
      expect(result.state).toBe('completed')

      // The checkout is gone, git registration is gone, the name is retired.
      expect(existsSync(worktree.canonicalRoot)).toBe(false)
      expect(
        git(f.repoPath, ['worktree', 'list', '--porcelain']).stdout.includes(worktree.canonicalRoot)
      ).toBe(false)
      expect(f.service.retiredNames(scope, repo.id).names).toContain(worktree.name)

      // The retired name can never come back.
      mkdirSync(join(f.workspace, worktree.name), { recursive: true })
      expect(
        await codeOf(() =>
          f.service.createWorktree({
            scope,
            repoId: repo.id,
            projectId: projectIdA,
            baseRef: 'main',
            worktreeBaseDir: f.workspace,
            destinationName: worktree.name,
          })
        )
      ).toBe('name_collision')
    } finally {
      f.cleanup()
    }
  })

  test('plan drift between plan and commit refuses with plan_stale, keeping data', async () => {
    const f = fixture()
    try {
      const { worktree } = await cleanWorktree(f)
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['quarantine_worktree'],
      })
      // Drift: an untracked file appears after the plan.
      writeFileSync(join(worktree.canonicalRoot, 'late.txt'), 'surprise\n')
      await expect(
        f.service.commitCleanup({ scope, plan, digest: plan.digest })
      ).rejects.toMatchObject({
        code: 'plan_stale',
      })
      expect(existsSync(join(worktree.canonicalRoot, 'README.md'))).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  test('a digest mismatch refuses the commit before any side effect', async () => {
    const f = fixture()
    try {
      const { worktree } = await cleanWorktree(f)
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['quarantine_worktree'],
      })
      await expect(
        f.service.commitCleanup({ scope, plan, digest: 'e'.repeat(64) })
      ).rejects.toMatchObject({
        code: 'plan_stale',
      })
      expect(existsSync(worktree.canonicalRoot)).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  test('an unknown cleanup resource fails ownership-unproven', async () => {
    const f = fixture()
    try {
      const { worktree } = await cleanWorktree(f)
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['stop_owned_resource'],
        selectedResourceIds: ['res-1'],
      })
      await expect(
        f.service.commitCleanup({ scope, plan, digest: plan.digest })
      ).rejects.toMatchObject({
        code: 'ownership_unproven',
      })
    } finally {
      f.cleanup()
    }
  })

  test('crash mid-cleanup surfaces recovery_required and keeps data', async () => {
    const f = fixture()
    try {
      const { worktree } = await cleanWorktree(f)
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['quarantine_worktree', 'unregister_worktree', 'delete_quarantine'],
      })

      // Simulate a crash after quarantine journaled completion but before the
      // record updated: journal the step, perform the rename, stop there.
      const journal = createCleanupJournal({
        file: join(f.dataDir, 'dev-runtime', 'worktrees', 'journal', `${plan.planId}.jsonl`),
      })
      journal.append({
        jobId: plan.planId,
        worktreeId: worktree.id,
        seq: 1,
        step: 'quarantine',
        state: 'started',
      })
      const identity = directoryIdentity(worktree.canonicalRoot)
      const moved = await import('../shell/src/dev-runtime/worktrees/trash').then((trash) =>
        trash.quarantineWorktree({
          worktreeId: worktree.id,
          worktreePath: worktree.canonicalRoot,
          repoPath: f.repoPath,
          expectedIdentity: {
            device: identity.identity.device ?? '',
            inode: identity.identity.inode ?? '',
          },
        })
      )
      journal.append({
        jobId: plan.planId,
        worktreeId: worktree.id,
        seq: 2,
        step: 'quarantine',
        state: 'completed',
        result: { trashRoot: moved.trashRoot, entryName: moved.entryName },
      })

      // Recovery: the journal proves a quarantined checkout; resume surfaces
      // recovery_required instead of silently finishing; data stays in trash.
      const resumed = await f.service.resumeCleanup({
        scope,
        worktreeId: worktree.id,
        jobId: plan.planId,
      })
      expect(resumed.state).toBe('recovery_required')
      expect(f.service.getWorktree(scope, worktree.id).lifecycle).toBe('recovery_required')
      expect(existsSync(join(moved.trashPath, 'README.md'))).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  test('the trash sweep drains quarantined entries left by cleanup', async () => {
    const dir = scratch('adea-service-sweep-')
    try {
      const f = fixture()
      // Rebuild the service with an immediately-stale sweep policy for tests.
      const { createWorktreeService } = await import('../shell/src/dev-runtime/worktrees/service')
      const service = createWorktreeService({
        dataDir: f.dataDir,
        runtimeNodeId: scope.runtimeNodeId,
        roots: f.roots,
        sweepStaleAfterMs: 0,
      })
      const repo = await service.registerRepo({
        scope,
        projectId: projectIdA,
        absolutePath: f.repoPath,
        bookmarkId: f.bookmarkId,
      })
      const created = await service.createWorktree({
        scope,
        repoId: repo.id,
        projectId: projectIdA,
        baseRef: 'main',
        worktreeBaseDir: f.workspace,
      })
      const worktree = created.worktree
      git(f.repoPath, ['branch', '--set-upstream-to=main', `adea/${worktree.name}`])
      const lease = service.leases.list(worktree.id)[0]
      service.leases.release({ scope, worktreeId: worktree.id, leaseId: lease.lease.id })
      const plan = await service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        // No delete_quarantine: the entry stays for the deferred sweep.
        selectedSteps: ['quarantine_worktree', 'unregister_worktree'],
      })
      await service.commitCleanup({ scope, plan, digest: plan.digest })
      expect(service.getWorktree(scope, worktree.id).lifecycle).toBe('quarantined')

      const trashRoot = join(f.workspace, '.adea-worktree-trash')
      service.sweep.begin([trashRoot])
      expect(service.sweep.page(10)).toMatchObject({ removed: 1, remaining: 0 })
      expect(service.sweep.pending()).toBe(0)
      expect(existsSync(worktree.canonicalRoot)).toBe(false)
      f.cleanup()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
