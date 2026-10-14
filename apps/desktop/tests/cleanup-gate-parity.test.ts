// Cleanup previews against the real executors (M14.03.2, adea#1218).
//
// `worktree-cleanup-preview.test.ts` pins the pure preview functions on
// hand-built facts. A preview that only agrees with itself proves nothing, so
// this suite drives the same scenarios through the real worktree service
// (interactive gate: plan, commit, resume) and the real cleanup-policy
// authority (automatic gate: evaluate) and asserts that the preview and the
// executor reach the same decision, including stale writes, authority revoked
// or expired while facts are being read, and crash/retry.
import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DevCommand, DevOperation, Scope } from '../../../packages/types/src/dev-runtime'
import type { CleanupFacts } from '../shell/src/dev-runtime/worktrees/cleanup-plan'
import {
  buildCleanupPreview,
  previewAutomaticCleanup,
  previewCleanupCommit,
  previewCleanupRecovery,
} from '../shell/src/dev-runtime/worktrees/cleanup-preview'
import { directoryIdentity } from '../shell/src/dev-runtime/worktrees/identity'
import { createCleanupJournal } from '../shell/src/dev-runtime/worktrees/journal'
import { createWorktreeService } from '../shell/src/dev-runtime/worktrees/service'
import { quarantineWorktree } from '../shell/src/dev-runtime/worktrees/trash'
import { workflowDigest } from '../shell/src/dev-runtime/worktrees/bootstrap'
import { createCleanupPolicyAuthority } from '../shell/src/dev-runtime/resources/policy'
import { fixture, git, projectIdA, scope } from './worktree-fixtures'

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

type Fixture = ReturnType<typeof fixture>

async function readyWorktree(f: Fixture, options: { releaseLease?: boolean } = {}) {
  const repo = await f.registerRepo()
  const created = await f.service.createWorktree({
    scope,
    repoId: repo.id,
    projectId: projectIdA,
    baseRef: 'main',
    worktreeBaseDir: f.workspace,
  })
  const worktree = created.worktree
  // Clean and pushed: the branch sits at its upstream, so push state is known.
  git(f.repoPath, ['branch', '--set-upstream-to=main', `adea/${worktree.name}`])
  if (options.releaseLease !== false) {
    const lease = f.service.leases.list(worktree.id)[0]
    f.service.leases.release({ scope, worktreeId: worktree.id, leaseId: lease.lease.id })
  }
  return { repo, worktree }
}

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
  return 'ok'
}

const FULL_STEPS = ['quarantine_worktree', 'unregister_worktree', 'delete_quarantine'] as const

describe('interactive gate: the preview and commitCleanup decide alike', () => {
  const scenarios: ReadonlyArray<{
    name: string
    arrange(f: Fixture, root: string): void | Promise<void>
    release?: boolean
    steps: readonly (typeof FULL_STEPS)[number][] | readonly ['prune_retained_data']
    allowed: boolean
    blockerCodes: readonly string[]
    sensitivity: 'clean' | 'dirty' | 'sensitive'
  }> = [
    {
      name: 'clean worktree, full removal',
      arrange: () => undefined,
      steps: FULL_STEPS,
      allowed: true,
      blockerCodes: [],
      sensitivity: 'clean',
    },
    {
      name: 'untracked file, full removal',
      arrange: (_f, root) => writeFileSync(join(root, 'scratch.txt'), 'unsaved work\n'),
      steps: FULL_STEPS,
      allowed: false,
      blockerCodes: ['dirty'],
      sensitivity: 'dirty',
    },
    {
      name: 'untracked file, retained data only',
      arrange: (_f, root) => writeFileSync(join(root, 'scratch.txt'), 'unsaved work\n'),
      steps: ['prune_retained_data'],
      allowed: true,
      blockerCodes: ['dirty'],
      sensitivity: 'dirty',
    },
    {
      name: 'live lease, full removal',
      arrange: () => undefined,
      release: false,
      steps: FULL_STEPS,
      allowed: false,
      blockerCodes: ['leased'],
      sensitivity: 'sensitive',
    },
  ]

  for (const scenario of scenarios) {
    test(`${scenario.name}`, async () => {
      const f = fixture()
      try {
        const { worktree } = await readyWorktree(f, { releaseLease: scenario.release })
        await scenario.arrange(f, worktree.canonicalRoot)
        const plan = await f.service.planCleanup({
          scope,
          worktreeId: worktree.id,
          expectedGeneration: worktree.generation,
          selectedSteps: [...scenario.steps],
        })
        const preview = buildCleanupPreview({
          facts: plan.facts,
          selectedSteps: plan.selectedSteps,
        })
        expect(preview.executesNothing).toBe(true)
        expect(preview.sensitivity).toBe(scenario.sensitivity)
        expect(preview.blockers.map((blocker) => blocker.code)).toEqual([...scenario.blockerCodes])
        expect(plan.blockers.map((blocker) => blocker.code)).toEqual([...scenario.blockerCodes])
        expect(preview.interactive.allowed).toBe(scenario.allowed)

        const outcome = await codeOf(() =>
          f.service.commitCleanup({ scope, plan, digest: plan.digest })
        )
        expect(outcome === 'ok').toBe(preview.interactive.allowed)
        if (!scenario.allowed) {
          expect(outcome).toBe('cleanup_blocked')
          expect(preview.interactive.refusal).toBe('cleanup_blocked')
          // The refusal ran before any step: the checkout is untouched.
          expect(existsSync(join(worktree.canonicalRoot, 'README.md'))).toBe(true)
          expect(f.service.getWorktree(scope, worktree.id).lifecycle).toBe('ready')
        } else if (scenario.steps[0] === 'prune_retained_data') {
          // The narrowed plan ran, and left the dirty checkout in place.
          expect(existsSync(join(worktree.canonicalRoot, 'scratch.txt'))).toBe(true)
          // A retained-data-only plan never removes the checkout, so the record
          // must not claim it was cleaned.
          expect(f.service.getWorktree(scope, worktree.id).lifecycle).toBe('ready')
        } else {
          expect(existsSync(worktree.canonicalRoot)).toBe(false)
        }
      } finally {
        f.cleanup()
      }
    })
  }

  test('a fact that moves between plan and commit is stale in the preview and in the executor', async () => {
    const f = fixture()
    try {
      const { worktree } = await readyWorktree(f)
      const request = {
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: [...FULL_STEPS],
      }
      const plan = await f.service.planCleanup(request)
      const planned = buildCleanupPreview({ facts: plan.facts, selectedSteps: plan.selectedSteps })
      expect(
        previewCleanupCommit({ planned, plannedFacts: plan.facts, observed: plan.facts })
      ).toEqual({ kind: 'runnable', executesNothing: true })

      writeFileSync(join(worktree.canonicalRoot, 'late.txt'), 'appeared after the plan\n')
      // A fresh observation is what the executor re-reads at commit.
      const observed = (await f.service.planCleanup(request)).facts
      expect(previewCleanupCommit({ planned, plannedFacts: plan.facts, observed })).toEqual({
        kind: 'stale',
        executesNothing: true,
        changedField: 'untracked',
        action: 'replan_cleanup',
      })
      expect(
        await codeOf(() => f.service.commitCleanup({ scope, plan, digest: plan.digest }))
      ).toBe('plan_stale')
      expect(existsSync(join(worktree.canonicalRoot, 'late.txt'))).toBe(true)
      expect(f.service.getWorktree(scope, worktree.id).lifecycle).toBe('ready')
      expect(
        previewCleanupCommit({ planned, plannedFacts: plan.facts, observed: null })
      ).toMatchObject({ kind: 'facts_unavailable', action: 'replan_cleanup' })
    } finally {
      f.cleanup()
    }
  })

  test('a plan blocked at planning time stays blocked at commit even when the facts have not moved', async () => {
    const f = fixture()
    try {
      const { worktree } = await readyWorktree(f, { releaseLease: false })
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: [...FULL_STEPS],
      })
      const planned = buildCleanupPreview({ facts: plan.facts, selectedSteps: plan.selectedSteps })
      expect(
        previewCleanupCommit({ planned, plannedFacts: plan.facts, observed: plan.facts })
      ).toMatchObject({ kind: 'blocked', blockerCodes: ['leased'] })
      expect(
        await codeOf(() => f.service.commitCleanup({ scope, plan, digest: plan.digest }))
      ).toBe('cleanup_blocked')
    } finally {
      f.cleanup()
    }
  })
})

describe('crash and retry: the recovery preview follows resumeCleanup', () => {
  /** A crash after the quarantine rename was journaled and before the record
   *  update, then a restarted service; returns what the restart reports. */
  async function crashAfterQuarantine(f: Fixture, provenance: 'proven' | 'unproven') {
    const { worktree } = await readyWorktree(f)
    const plan = await f.service.planCleanup({
      scope,
      worktreeId: worktree.id,
      expectedGeneration: worktree.generation,
      selectedSteps: [...FULL_STEPS],
    })
    const journal = createCleanupJournal({
      file: join(f.dataDir, 'dev-runtime', 'worktrees', 'journal', `${plan.planId}.jsonl`),
    })
    const identity = directoryIdentity(worktree.canonicalRoot)
    const proof = {
      device: identity.identity.device ?? '',
      inode: identity.identity.inode ?? '',
    }
    journal.append({
      jobId: plan.planId,
      worktreeId: worktree.id,
      seq: 1,
      step: 'quarantine',
      state: 'started',
    })
    const moved = quarantineWorktree({
      worktreeId: worktree.id,
      worktreePath: worktree.canonicalRoot,
      repoPath: f.repoPath,
      expectedIdentity: proof,
    })
    journal.append({
      jobId: plan.planId,
      worktreeId: worktree.id,
      seq: 2,
      step: 'quarantine',
      state: 'completed',
      result: {
        trashRoot: moved.trashRoot,
        entryName: moved.entryName,
        // An older or damaged journal lacks the identity proof rollback needs.
        ...(provenance === 'proven' ? { identity: proof } : {}),
      },
    })
    const restarted = createWorktreeService({
      dataDir: f.dataDir,
      runtimeNodeId: scope.runtimeNodeId,
      roots: f.roots,
      clock: () => new Date(),
    })
    const resumed = await restarted.resumeCleanup({
      scope,
      worktreeId: worktree.id,
      jobId: plan.planId,
    })
    return { worktree, plan, restarted, resumed, moved }
  }

  test('a rolled-back crash reruns the quarantine on a retried plan instead of replaying it', async () => {
    const f = fixture()
    try {
      const { worktree, plan, restarted, resumed } = await crashAfterQuarantine(f, 'proven')
      expect(resumed.state).toBe('partial')
      const completed = resumed.stepResults
        .filter((step) => step.state === 'completed')
        .map((step) => step.step)
      expect(completed).toEqual([])
      expect(
        previewCleanupRecovery({
          job: { jobId: resumed.planId, state: resumed.state, completedSteps: completed },
        })
      ).toMatchObject({ state: 'partial', nextAction: 'resume', completedSteps: [] })
      expect(existsSync(join(worktree.canonicalRoot, 'README.md'))).toBe(true)

      // The retry. The journal still holds the crashed quarantine's
      // `completed` entry; its `rolled_back` successor must cancel it, or the
      // retry would replay a rename that no longer exists and mark a live
      // checkout quarantined.
      const retried = await restarted.commitCleanup({ scope, plan, digest: plan.digest })
      expect(retried.state).toBe('completed')
      expect(retried.stepResults.map((step) => step.state)).toEqual([
        'completed',
        'completed',
        'completed',
      ])
      expect(existsSync(worktree.canonicalRoot)).toBe(false)
      expect(restarted.getWorktree(scope, worktree.id).lifecycle).toBe('cleaned')
      expect(
        git(f.repoPath, ['worktree', 'list', '--porcelain']).stdout.includes(worktree.canonicalRoot)
      ).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  test('resuming again after a rollback stays safe: the restored checkout keeps its lifecycle', async () => {
    const f = fixture()
    try {
      const { worktree, plan, restarted, resumed } = await crashAfterQuarantine(f, 'proven')
      expect(resumed.state).toBe('partial')
      const before = restarted.getWorktree(scope, worktree.id)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const again = await restarted.resumeCleanup({
          scope,
          worktreeId: worktree.id,
          jobId: plan.planId,
        })
        expect(again.state).toBe('partial')
        expect(again.stepResults[0]).toMatchObject({
          step: 'quarantine_worktree',
          state: 'rolled_back',
        })
        expect(restarted.getWorktree(scope, worktree.id)).toEqual(before)
        expect(existsSync(join(worktree.canonicalRoot, 'README.md'))).toBe(true)
      }
      // A restart after the rollback (the first response was lost) resumes the
      // same way: the durable journal and record are all it has.
      const afterRestart = createWorktreeService({
        dataDir: f.dataDir,
        runtimeNodeId: scope.runtimeNodeId,
        roots: f.roots,
        clock: () => new Date(),
      })
      const lost = await afterRestart.resumeCleanup({
        scope,
        worktreeId: worktree.id,
        jobId: plan.planId,
      })
      expect(lost.state).toBe('partial')
      expect(afterRestart.getWorktree(scope, worktree.id)).toEqual(before)

      // And the retry still works after the repeated resumes.
      expect((await afterRestart.commitCleanup({ scope, plan, digest: plan.digest })).state).toBe(
        'completed'
      )
      expect(existsSync(worktree.canonicalRoot)).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  test('a completed retained-data-only job is resume-safe: lifecycle and directory stay as they were', async () => {
    const f = fixture()
    try {
      const { worktree } = await readyWorktree(f)
      writeFileSync(join(worktree.canonicalRoot, 'scratch.txt'), 'unsaved work\n')
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['prune_retained_data'],
      })
      const committed = await f.service.commitCleanup({ scope, plan, digest: plan.digest })
      expect(committed.state).toBe('completed')
      const before = f.service.getWorktree(scope, worktree.id)
      expect(before.lifecycle).toBe('ready')

      const restarted = () =>
        createWorktreeService({
          dataDir: f.dataDir,
          runtimeNodeId: scope.runtimeNodeId,
          roots: f.roots,
          clock: () => new Date(),
        })
      // The response was lost: the same service, then restarted ones, resume.
      for (const service of [f.service, f.service, restarted(), restarted()]) {
        const again = await service.resumeCleanup({
          scope,
          worktreeId: worktree.id,
          jobId: plan.planId,
        })
        expect(again).toMatchObject({
          state: 'completed',
          stepResults: [{ step: 'prune_retained_data', state: 'completed' }],
        })
        expect(service.getWorktree(scope, worktree.id)).toEqual(before)
        expect(existsSync(join(worktree.canonicalRoot, 'scratch.txt'))).toBe(true)
        expect(existsSync(join(worktree.canonicalRoot, 'README.md'))).toBe(true)
      }
    } finally {
      f.cleanup()
    }
  })

  test('resuming a completed job reports only what ran: a selected deletion that never ran is skipped', async () => {
    const f = fixture()
    try {
      const { worktree } = await readyWorktree(f)
      // delete_quarantine without quarantine_worktree has nothing to delete.
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['delete_quarantine', 'prune_retained_data'],
      })
      const committed = await f.service.commitCleanup({ scope, plan, digest: plan.digest })
      expect(committed.state).toBe('completed')
      const before = f.service.getWorktree(scope, worktree.id)
      expect(before.lifecycle).toBe('ready')

      const restarted = createWorktreeService({
        dataDir: f.dataDir,
        runtimeNodeId: scope.runtimeNodeId,
        roots: f.roots,
        clock: () => new Date(),
      })
      for (const service of [f.service, restarted]) {
        const resumed = await service.resumeCleanup({
          scope,
          worktreeId: worktree.id,
          jobId: plan.planId,
        })
        expect(resumed.state).toBe('completed')
        const byStep = Object.fromEntries(resumed.stepResults.map((r) => [r.step, r.state]))
        expect(byStep).toEqual({ delete_quarantine: 'skipped', prune_retained_data: 'completed' })
        // Commit and resume agree on what ran.
        expect(
          committed.stepResults.filter((r) => r.state === 'completed').map((r) => r.step)
        ).toEqual(['prune_retained_data'])
        expect(service.getWorktree(scope, worktree.id)).toEqual(before)
      }
    } finally {
      f.cleanup()
    }
  })

  test('resuming a completed full removal reports every journaled step completed', async () => {
    const f = fixture()
    try {
      const { worktree } = await readyWorktree(f)
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: [...FULL_STEPS],
      })
      expect((await f.service.commitCleanup({ scope, plan, digest: plan.digest })).state).toBe(
        'completed'
      )
      const resumed = await f.service.resumeCleanup({
        scope,
        worktreeId: worktree.id,
        jobId: plan.planId,
      })
      expect(resumed.state).toBe('completed')
      expect(resumed.stepResults.map((r) => [r.step, r.state])).toEqual([
        ['quarantine_worktree', 'completed'],
        ['unregister_worktree', 'completed'],
        ['delete_quarantine', 'completed'],
      ])
    } finally {
      f.cleanup()
    }
  })

  for (const selectedSteps of [['run_teardown'], ['run_teardown', ...FULL_STEPS]] as const) {
    test(`a completed teardown resumes as completed, never skipped: ${selectedSteps.join(', ')}`, async () => {
      const f = fixture()
      try {
        const { repo, worktree } = await readyWorktree(f)
        const workflow = {
          id: 'teardown',
          version: 1,
          steps: [{ id: 'ok', argv: [process.execPath, '-e', 'process.exit(0)'] }],
        }
        f.service.bindBootstrap({
          worktreeId: worktree.id,
          workflow,
          approval: {
            method: 'owner_dialog' as const,
            reference: 'consent',
            approvedAt: new Date().toISOString(),
            canonicalRepoRoot: repo.canonicalRoot,
            workflowDigest: workflowDigest(workflow),
            workflowVersion: 1,
            scope,
          },
        })
        const plan = await f.service.planCleanup({
          scope,
          worktreeId: worktree.id,
          expectedGeneration: worktree.generation,
          selectedSteps: [...selectedSteps],
        })
        expect(plan.blockers).toEqual([])
        const committed = await f.service.commitCleanup({ scope, plan, digest: plan.digest })
        expect(committed.state).toBe('completed')
        expect(committed.stepResults.find((r) => r.step === 'run_teardown')?.state).toBe(
          'completed'
        )
        const before = f.service.getWorktree(scope, worktree.id)
        const restarted = createWorktreeService({
          dataDir: f.dataDir,
          runtimeNodeId: scope.runtimeNodeId,
          roots: f.roots,
          clock: () => new Date(),
        })
        for (const service of [f.service, f.service, restarted, restarted]) {
          const resumed = await service.resumeCleanup({
            scope,
            worktreeId: worktree.id,
            jobId: plan.planId,
          })
          expect(resumed.state).toBe('completed')
          expect(resumed.stepResults.find((r) => r.step === 'run_teardown')?.state).toBe(
            'completed'
          )
          expect(service.getWorktree(scope, worktree.id)).toEqual(before)
        }
      } finally {
        f.cleanup()
      }
    })
  }

  test('an unprovable interruption stays recovery_required; the preview offers no automatic retry', async () => {
    const f = fixture()
    try {
      const { worktree, plan, restarted, resumed, moved } = await crashAfterQuarantine(
        f,
        'unproven'
      )
      expect(resumed.state).toBe('recovery_required')
      const completed = resumed.stepResults
        .filter((step) => step.state === 'completed')
        .map((step) => step.step)
      expect(completed).toEqual(['quarantine_worktree'])
      expect(
        previewCleanupRecovery({
          job: { jobId: resumed.planId, state: resumed.state, completedSteps: completed },
        })
      ).toMatchObject({ nextAction: 'manual_recovery', completedSteps: ['quarantine_worktree'] })

      // The preview is right that nothing continues on its own: a second
      // resume reports the same state, and re-committing the plan refuses on
      // the changed facts without touching the quarantined checkout.
      expect(
        (await restarted.resumeCleanup({ scope, worktreeId: worktree.id, jobId: plan.planId }))
          .state
      ).toBe('recovery_required')
      expect(
        await codeOf(() => restarted.commitCleanup({ scope, plan, digest: plan.digest }))
      ).not.toBe('ok')
      expect(existsSync(join(moved.trashPath, 'README.md'))).toBe(true)
      expect(existsSync(worktree.canonicalRoot)).toBe(false)
    } finally {
      f.cleanup()
    }
  })
})

describe('a refused registration cleanup rolls the quarantine back durably', () => {
  function serviceWithPrune(
    f: Fixture,
    prune: (repoPath: string) => Promise<{ exitCode: number; stderr: string }>
  ) {
    return createWorktreeService({
      dataDir: f.dataDir,
      runtimeNodeId: scope.runtimeNodeId,
      roots: f.roots,
      clock: () => new Date(),
      pruneRegistrations: prune,
    })
  }

  test('the checkout returns, the record is ready again, the rollback is journaled, and a re-plan completes', async () => {
    const f = fixture()
    try {
      const { worktree } = await readyWorktree(f)
      const refusing = serviceWithPrune(f, async () => ({ exitCode: 1, stderr: 'prune refused' }))
      const request = {
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: [...FULL_STEPS],
      }
      const plan = await refusing.planCleanup(request)
      expect(await codeOf(() => refusing.commitCleanup({ scope, plan, digest: plan.digest }))).toBe(
        'rollback_failed'
      )
      expect(existsSync(join(worktree.canonicalRoot, 'README.md'))).toBe(true)
      const restored = refusing.getWorktree(scope, worktree.id)
      expect(restored.lifecycle).toBe('ready')
      expect(restored.quarantine).toBeUndefined()
      const journal = createCleanupJournal({
        file: join(f.dataDir, 'dev-runtime', 'worktrees', 'journal', `${plan.planId}.jsonl`),
      })
      expect(journal.latestSteps(plan.planId).get('quarantine')?.state).toBe('rolled_back')
      expect(journal.completedSteps(plan.planId).has('quarantine')).toBe(false)

      // The record moved on (generation), so the old plan is stale rather than
      // silently re-run; a resume reports the rollback and changes nothing.
      expect(await codeOf(() => refusing.commitCleanup({ scope, plan, digest: plan.digest }))).toBe(
        'plan_stale'
      )
      const resumed = await refusing.resumeCleanup({
        scope,
        worktreeId: worktree.id,
        jobId: plan.planId,
      })
      expect(resumed.state).toBe('partial')
      expect(refusing.getWorktree(scope, worktree.id)).toEqual(restored)

      // A fresh plan against a working Git completes normally.
      const fresh = await f.service.planCleanup({
        ...request,
        expectedGeneration: restored.generation,
      })
      expect(fresh.blockers).toEqual([])
      expect(
        (await f.service.commitCleanup({ scope, plan: fresh, digest: fresh.digest })).state
      ).toBe('completed')
      expect(existsSync(worktree.canonicalRoot)).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  test('when the checkout cannot be restored nothing claims it was: recovery_required, entry kept in trash', async () => {
    const f = fixture()
    try {
      const { worktree } = await readyWorktree(f)
      const blocked = serviceWithPrune(f, async () => {
        // Something took the original path while the checkout sat in trash.
        mkdirSync(worktree.canonicalRoot)
        writeFileSync(join(worktree.canonicalRoot, 'occupied.txt'), 'in the way\n')
        return { exitCode: 1, stderr: 'prune refused' }
      })
      const plan = await blocked.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: [...FULL_STEPS],
      })
      expect(await codeOf(() => blocked.commitCleanup({ scope, plan, digest: plan.digest }))).toBe(
        'rollback_failed'
      )
      const record = blocked.getWorktree(scope, worktree.id)
      expect(record.lifecycle).toBe('recovery_required')
      expect(record.quarantine).toBeDefined()
      const journal = createCleanupJournal({
        file: join(f.dataDir, 'dev-runtime', 'worktrees', 'journal', `${plan.planId}.jsonl`),
      })
      // No rollback was journaled, so nothing treats the quarantine as undone.
      expect(journal.latestSteps(plan.planId).get('quarantine')?.state).toBe('completed')
      expect(
        existsSync(join(record.quarantine!.trashRoot, record.quarantine!.entryName, 'README.md'))
      ).toBe(true)
    } finally {
      f.cleanup()
    }
  })
})

describe('automatic gate: the preview and dev.cleanupPolicy.evaluate decide alike', () => {
  const SCOPE: Scope = {
    accountId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    runtimeNodeId: '00000000-0000-4000-8000-000000000003',
  }
  const PREDICATES = [{ kind: 'clean' }, { kind: 'pushed' }, { kind: 'no_active_leases' }] as const
  const GOOD_FACTS = { clean: 'true', pushed: 'true', active_leases: '0' } as const
  const STEPS = ['prune_retained_data'] as const

  function worktreeFacts(): CleanupFacts {
    return {
      ahead: 0,
      attachedOwnedResources: [],
      behind: 0,
      branchRef: 'refs/heads/feature',
      canonicalRoot: '/tmp/fixture-worktree',
      conflicted: false,
      dangerous: false,
      dirty: false,
      generation: 3,
      gitdirProven: true,
      hasLiveLeases: false,
      headBranch: 'feature',
      headSha: 'a'.repeat(40),
      identityProven: true,
      isDefaultBranch: false,
      isProtectedBranch: false,
      lifecycle: 'ready',
      nestedWorktrees: [],
      provenance: 'adea',
      repoPath: '/tmp/fixture-repo',
      trashRootUsable: true,
      unpushedCommits: 0,
      untracked: false,
      upstreamKnown: true,
      worktreeId: '00000000-0000-4000-8000-0000000000aa',
    }
  }

  function command(
    operation: DevOperation,
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ): DevCommand {
    return {
      schemaVersion: 1,
      operation,
      requestId: randomUUID(),
      nonce: 'A'.repeat(22),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope: SCOPE,
      capabilities: [],
      ...(resource ? { resource } : {}),
      body,
    } as DevCommand
  }

  function boot(options: {
    facts?: () => Promise<Record<string, string> | undefined> | Record<string, string> | undefined
    startMs?: number
  }) {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-gate-parity-'))
    scratch.push(dataDir)
    const providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {}
    const clock = { ms: options.startMs ?? Date.parse('2026-10-09T00:00:00.000Z') }
    createCleanupPolicyAuthority({
      authority: {
        registerCommandProvider(operation: DevOperation, handler: (c: DevCommand) => unknown) {
          providers[operation] = handler
        },
      } as never,
      dataDir,
      scope: SCOPE,
      approvalVerifier: {
        recordIssuance: () => undefined,
        consume: () => undefined,
        consumeByReference: () => undefined,
      },
      worktreeFacts: () => (options.facts ? options.facts() : GOOD_FACTS),
      now: () => clock.ms,
      randomId: () => randomUUID(),
    })
    const call = (
      operation: DevOperation,
      body: Record<string, unknown>,
      generation: number,
      id: string
    ) => providers[operation]!(command(operation, body, { kind: 'cleanup_policy', id, generation }))
    const draft = (policyExpiresAt?: string) =>
      providers['dev.cleanupPolicy.createDraft']!(
        command('dev.cleanupPolicy.createDraft', {
          projectId: 'proj-1',
          name: 'auto-clean',
          predicates: [...PREDICATES],
          allowedSteps: [...STEPS],
          ...(policyExpiresAt ? { policyExpiresAt } : {}),
        })
      ) as { id: string }
    const approve = (id: string) =>
      call(
        'dev.cleanupPolicy.approve',
        { cleanupPolicyId: id, expectedVersion: 1, approvalId: 'approval-1' },
        1,
        id
      )
    const disable = (id: string, version: number) =>
      call(
        'dev.cleanupPolicy.disable',
        { cleanupPolicyId: id, expectedVersion: version },
        version,
        id
      )
    const evaluate = (id: string, version: number) =>
      call(
        'dev.cleanupPolicy.evaluate',
        {
          cleanupPolicyId: id,
          expectedVersion: version,
          worktreeId: 'wt-1',
          expectedGeneration: 1,
        },
        version,
        id
      ) as Promise<{ matched: boolean; blockers: Array<{ code: string }> }>
    const list = () =>
      (
        providers['dev.cleanupPolicy.list']!(command('dev.cleanupPolicy.list', {})) as {
          items: Array<{
            id: string
            state: 'draft' | 'approved' | 'disabled' | 'expired' | 'superseded'
            allowedSteps: Array<(typeof STEPS)[number]>
            expiresAt?: string
          }>
        }
      ).items
    return { clock, draft, approve, disable, evaluate, list }
  }

  /** What the preview says about the policy exactly as the executor stores it now. */
  function previewOf(
    harness: ReturnType<typeof boot>,
    id: string,
    automaticFacts: Record<string, string> | null = GOOD_FACTS
  ) {
    const policy = harness.list().find((entry) => entry.id === id)!
    return previewAutomaticCleanup({
      policy,
      predicates: [...PREDICATES],
      facts: automaticFacts ? worktreeFacts() : null,
      automaticFacts,
      selectedSteps: [...STEPS],
      now: new Date(harness.clock.ms),
    })
  }

  test('an approved policy with satisfied predicates runs in both', async () => {
    const h = boot({})
    const { id } = h.draft()
    h.approve(id)
    expect((await h.evaluate(id, 2)).matched).toBe(true)
    expect(previewOf(h, id)).toMatchObject({ allowed: true, executesNothing: true })
  })

  test('a draft and a revoked (disabled) policy authorize nothing in either', async () => {
    const h = boot({})
    const { id } = h.draft()
    await expect(h.evaluate(id, 1)).rejects.toMatchObject({ code: 'invalid_state' })
    expect(previewOf(h, id)).toMatchObject({ allowed: false, refusal: 'policy_not_approved' })

    h.approve(id)
    expect((await h.evaluate(id, 2)).matched).toBe(true)
    h.disable(id, 2)
    await expect(h.evaluate(id, 3)).rejects.toMatchObject({ code: 'invalid_state' })
    expect(previewOf(h, id)).toMatchObject({ allowed: false, refusal: 'policy_not_approved' })
  })

  test('a policy revoked while facts are being read is denied by the executor and by the preview', async () => {
    let revoke: (() => void) | undefined
    const h = boot({
      facts: async () => {
        await Promise.resolve()
        revoke?.()
        return { ...GOOD_FACTS }
      },
    })
    const { id } = h.draft()
    h.approve(id)
    revoke = () => h.disable(id, 2)
    const result = await h.evaluate(id, 2)
    // The pre-await snapshot said approved and the facts were all true; the
    // revocation that landed while they were read wins.
    expect(result.matched).toBe(false)
    expect(previewOf(h, id)).toMatchObject({ allowed: false, refusal: 'policy_not_approved' })
  })

  test('a policy that expires while facts are being read is denied by both', async () => {
    const start = Date.parse('2026-10-09T00:00:00.000Z')
    const hourLater = '2026-10-09T01:00:00.000Z'
    let advance: (() => void) | undefined
    const h = boot({
      startMs: start,
      facts: async () => {
        await Promise.resolve()
        advance?.()
        return { ...GOOD_FACTS }
      },
    })
    const { id } = h.draft(hourLater)
    h.approve(id)
    expect((await h.evaluate(id, 2)).matched).toBe(true)
    advance = () => {
      h.clock.ms = Date.parse(hourLater) + 1
    }
    expect((await h.evaluate(id, 2)).matched).toBe(false)
    expect(previewOf(h, id)).toMatchObject({ allowed: false, refusal: 'policy_expired' })
  })

  test('an unprovable clock denies both even with every fact true', async () => {
    const h = boot({})
    const { id } = h.draft()
    h.approve(id)
    h.clock.ms = Number.NaN
    expect((await h.evaluate(id, 2)).matched).toBe(false)
    expect(previewOf(h, id)).toMatchObject({ allowed: false, refusal: 'policy_invalid' })
  })

  test('missing facts and unmet predicates deny both with the same blockers', async () => {
    const missing = boot({ facts: () => undefined })
    const a = missing.draft()
    missing.approve(a.id)
    expect((await missing.evaluate(a.id, 2)).matched).toBe(false)
    expect(previewOf(missing, a.id, null)).toMatchObject({
      allowed: false,
      refusal: 'policy_facts_unavailable',
    })

    const dirty = { clean: 'false', pushed: 'true', active_leases: '2' }
    const unmet = boot({ facts: () => dirty })
    const b = unmet.draft()
    unmet.approve(b.id)
    const result = await unmet.evaluate(b.id, 2)
    const preview = previewOf(unmet, b.id, dirty)
    expect(result.matched).toBe(false)
    expect(preview).toMatchObject({ allowed: false, refusal: 'policy_predicates_unmet' })
    expect(preview.blockers.map((blocker) => blocker.code)).toEqual(
      result.blockers.map((blocker) => blocker.code)
    )
  })
})
