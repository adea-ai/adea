// Merge-back: squash (default strategy) into the target branch through a
// temporary detached worktree, with expected-SHA compare-and-swap publication.
//
// The plan records base/head/target expected SHAs and refuses moved refs. The
// temporary worktree holds the squash commit; publication is either a
// fast-forward merge in the checkout that has the target branch, or a CAS
// `update-ref` against the expected target SHA — never a rewrite of a ref that
// moved. A conflict or a crash retains the temporary worktree, its reference,
// and an exact recovery token with continue/abort instructions; unlike the
// donor, the temp worktree is removed only after proven success.
//
// Squash-merge concept and expected-SHA publication: bb
// (https://github.com/get-bb/bb) `packages/host-workspace/src/workspace.ts`,
// pinned revision 52a9256373d4d36f9b60e9e2a7f333464091a2ac, MIT License.
// Copyright (c) 2026 Michael Yong. Hardened: durable recovery retention
// replaces the donor's `finally` removal, typed plans/digests, and registered
// temp-worktree cleanup.
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { nowIso, newRecordId } from '../authority'
import { createDurableJsonStore } from '../host-store'
import { runGit, runGitChecked } from './git-run'
import { WorktreeError } from './errors'
import { proveWorktreeRegistration } from './identity'
import { parseWorktreeList } from './discovery'

export type MergeStrategy = 'squash'

export type MergePlan = Readonly<{
  planId: string
  worktreeId: string
  repoPath: string
  strategy: MergeStrategy
  sourceBranch: string
  sourceHeadSha: string
  targetRef: string
  expectedTargetSha: string
  mergeBaseSha: string
  commitMessage: string
  digest: string
  createdAt: string
}>

export type MergeOutcome = Readonly<{
  state: 'merged' | 'conflicted' | 'no_changes'
  targetRef: string
  publishedSha?: string
  recoveryToken?: string
  tempWorktreePath?: string
  instructions?: string
}>

type MergeRecord = Readonly<{
  token: string
  worktreeId: string
  repoPath: string
  planId: string
  state: 'in_progress' | 'conflicted' | 'merged' | 'aborted'
  tempWorktreePath?: string
  tempBranchRef?: string
  squashedSha?: string
  targetRef?: string
  expectedTargetSha?: string
  updatedAt: string
}>

export const DEFAULT_MERGE_STRATEGY: MergeStrategy = 'squash'

async function currentBranch(repoPath: string): Promise<string | null> {
  const result = await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: repoPath })
  return result.exitCode === 0 ? result.stdout.trim() : null
}

/** Expected-SHA branch deletion: only when the branch still points at the
 *  proven SHA. Callers invoke this only after successful integration and
 *  worktree removal. */
async function deleteBranchIfUnchanged(input: {
  repoPath: string
  branchRef: string
  expectedSha: string
}): Promise<{ deleted: boolean }> {
  if (!input.branchRef.startsWith('refs/heads/')) {
    throw new WorktreeError('invalid_state', 'branch deletion expects a local branch ref')
  }
  const update = await runGit(['update-ref', '-d', input.branchRef, input.expectedSha], {
    cwd: input.repoPath,
  })
  if (update.exitCode !== 0) {
    throw new WorktreeError('remote_changed', 'branch moved; expected-SHA deletion refused', {
      action: 'recheck_branch',
    })
  }
  return { deleted: true }
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function planDigestOf(plan: Omit<MergePlan, 'digest' | 'createdAt'>): string {
  return sha256Text(JSON.stringify(plan))
}

function shortToken(token: string): string {
  return token.slice(0, 8)
}

export type MergeService = ReturnType<typeof createMergeService>

export function createMergeService(options: {
  dataDir: string
  /** Directory root for temporary detached worktrees. */
  tempRoot?: string
  clock?: () => Date
}) {
  const { dataDir, clock = () => new Date() } = options
  const tempRoot = options.tempRoot ?? join(dataDir, 'dev-runtime', 'worktrees', 'merge-temp')
  const records = createDurableJsonStore<MergeRecord>({
    file: join(dataDir, 'dev-runtime', 'worktrees', 'merge-records.json'),
    schemaVersion: 1,
    label: 'worktree merge',
  })

  /** Build the plan. Every fact is observed here and re-proven at commit time;
   *  a moved ref between plan and commit is a refusal, never a surprise. */
  async function planMerge(input: {
    worktreeId: string
    worktreeRoot: string
    repoPath: string
    targetRef: string
    expectedTargetSha?: string
    commitMessage: string
    strategy?: MergeStrategy
  }): Promise<MergePlan> {
    if ((input.strategy ?? DEFAULT_MERGE_STRATEGY) !== 'squash') {
      throw new WorktreeError('invalid_state', `unsupported merge strategy: ${input.strategy}`)
    }
    const registration = await proveWorktreeRegistration(input.worktreeRoot)
    if (!registration) {
      throw new WorktreeError('gitdir_unproven', 'source worktree registration could not be proven')
    }

    const sourceBranch = await currentBranch(input.worktreeRoot)
    if (!sourceBranch || !sourceBranch.startsWith('refs/heads/')) {
      throw new WorktreeError('invalid_state', 'cannot merge back from a detached checkout')
    }
    const sourceHeadSha = (
      await runGitChecked(['rev-parse', 'HEAD'], { cwd: input.worktreeRoot })
    ).stdout.trim()

    // The target must be a local branch; a remote-tracking spelling is a
    // category error (we never publish to a remote ref shape).
    if (!input.targetRef.startsWith('refs/heads/')) {
      throw new WorktreeError('invalid_state', 'merge target must be a local branch')
    }
    const targetSha = (
      await runGitChecked(['rev-parse', input.targetRef], {
        cwd: input.repoPath,
        classify: () => 'base_not_found',
      })
    ).stdout.trim()
    if (input.expectedTargetSha !== undefined && input.expectedTargetSha !== targetSha) {
      throw new WorktreeError('remote_changed', 'target ref moved since the plan was requested', {
        action: 'replan_merge',
      })
    }
    const mergeBaseSha = (
      await runGitChecked(['merge-base', input.targetRef, sourceHeadSha], { cwd: input.repoPath })
    ).stdout.trim()

    const fields = {
      planId: newRecordId(),
      worktreeId: input.worktreeId,
      repoPath: input.repoPath,
      strategy: DEFAULT_MERGE_STRATEGY,
      sourceBranch,
      sourceHeadSha,
      targetRef: input.targetRef,
      expectedTargetSha: targetSha,
      mergeBaseSha,
      commitMessage: input.commitMessage.slice(0, 10_000),
    }
    return { ...fields, digest: planDigestOf(fields), createdAt: nowIso(clock) }
  }

  /** Execute a plan. Idempotent per plan id: re-invoking a plan that already
   *  merged replays the outcome instead of re-merging. */
  async function commitMerge(input: {
    plan: MergePlan
    digest: string
    signal?: AbortSignal
  }): Promise<MergeOutcome> {
    const plan = input.plan
    const { digest: _planDigest, createdAt: _planCreatedAt, ...planFields } = plan
    if (planDigestOf(planFields) !== input.digest) {
      throw new WorktreeError('plan_stale', 'merge plan digest does not match the plan')
    }
    const existing = records
      .load()
      .records.find((entry) => entry.planId === plan.planId && entry.state === 'merged')
    if (existing) {
      return {
        state: 'merged',
        targetRef: plan.targetRef,
        ...(existing.squashedSha ? { publishedSha: existing.squashedSha } : {}),
      }
    }

    // The target must still be where the plan proved it.
    const currentTargetSha = (
      await runGitChecked(['rev-parse', plan.targetRef], {
        cwd: plan.repoPath,
        classify: () => 'base_not_found',
      })
    ).stdout.trim()
    if (currentTargetSha !== plan.expectedTargetSha) {
      throw new WorktreeError('remote_changed', 'target ref moved during merge commit', {
        action: 'replan_merge',
      })
    }

    const token = newRecordId()
    const record: MergeRecord = {
      token,
      worktreeId: plan.worktreeId,
      repoPath: plan.repoPath,
      planId: plan.planId,
      state: 'in_progress',
      targetRef: plan.targetRef,
      expectedTargetSha: plan.expectedTargetSha,
      updatedAt: nowIso(clock),
    }
    appendRecord(record)

    // Temporary detached worktree at the EXPECTED target SHA: the commit is
    // built on exactly the history the plan proved, and the publish CAS below
    // refuses a moved branch.
    mkdirSync(tempRoot, { recursive: true, mode: 0o700 })
    const tempWorktreePath = join(tempRoot, `merge-${shortToken(token)}`)
    await runGitChecked(['worktree', 'add', '--detach', tempWorktreePath, plan.expectedTargetSha], {
      cwd: plan.repoPath,
    })
    updateRecord(token, { tempWorktreePath })

    const tempBranchRef = `refs/adea-merge/${token}`
    await runGitChecked(['update-ref', tempBranchRef, plan.sourceHeadSha], { cwd: plan.repoPath })
    updateRecord(token, { tempBranchRef })

    // Squash the source into the detached checkout.
    const merge = await runGit(['merge', '--squash', plan.sourceBranch], { cwd: tempWorktreePath })
    if (merge.exitCode !== 0) {
      const combined = merge.stdout + merge.stderr
      if (/CONFLICT|Automatic merge failed/.test(combined)) {
        updateRecord(token, { state: 'conflicted' })
        return {
          state: 'conflicted',
          targetRef: plan.targetRef,
          recoveryToken: token,
          tempWorktreePath,
          instructions:
            `Resolve the conflicts in ${tempWorktreePath}, stage them, then resume ` +
            `recovery token ${token}. Or abort token ${token} to discard the temporary worktree.`,
        }
      }
      // A non-conflict failure keeps the recovery record and the temp worktree
      // for inspection (donor defect: finally-removal hid the evidence).
      throw new WorktreeError(
        'invalid_state',
        `squash merge failed: ${combined.trim().slice(0, 512)}`
      )
    }

    const staged = await runGit(['diff', '--cached', '--quiet'], { cwd: tempWorktreePath })
    if (staged.exitCode === 0) {
      // Nothing to merge: not an error state, but the plan is consumed.
      await removeTempWorktree(token, tempWorktreePath, plan.repoPath)
      updateRecord(token, { state: 'aborted' })
      return { state: 'no_changes', targetRef: plan.targetRef }
    }

    await runGitChecked(['commit', '--no-verify', '-m', plan.commitMessage], {
      cwd: tempWorktreePath,
    })
    const squashedSha = (
      await runGitChecked(['rev-parse', 'HEAD'], { cwd: tempWorktreePath })
    ).stdout.trim()
    updateRecord(token, { squashedSha })

    await publish(token, plan.targetRef, plan.expectedTargetSha, squashedSha)
    await removeTempWorktree(token, tempWorktreePath, plan.repoPath)
    updateRecord(token, { state: 'merged' })
    return { state: 'merged', targetRef: plan.targetRef, publishedSha: squashedSha }
  }

  /** Fast-forward the checkout holding the target branch, or CAS the ref. */
  async function publish(
    token: string,
    targetRef: string,
    expectedSha: string,
    newSha: string
  ): Promise<void> {
    const record = requireRecord(token)
    // Which registered worktree (if any) has the target branch checked out?
    const list = await runGitChecked(['worktree', 'list', '--porcelain'], { cwd: record.repoPath })
    const entries = parseWorktreeList(list.stdout)
    const holder = entries.find((entry) => entry.branchRef === targetRef)
    if (holder) {
      const status = await runGit(['status', '--porcelain'], { cwd: holder.path })
      if (status.stdout.trim().length > 0) {
        throw new WorktreeError(
          'dirty',
          `target branch is checked out with uncommitted changes at ${holder.path}`
        )
      }
      const ff = await runGit(['merge', '--ff-only', newSha], { cwd: holder.path })
      if (ff.exitCode !== 0) {
        throw new WorktreeError(
          'invalid_state',
          `fast-forward of ${targetRef} failed: ${ff.stderr.trim().slice(0, 256)}`
        )
      }
      return
    }
    // CAS: the update only lands when the ref still equals the expected SHA.
    const update = await runGit(['update-ref', targetRef, newSha, expectedSha], {
      cwd: record.repoPath,
    })
    if (update.exitCode !== 0) {
      throw new WorktreeError('remote_changed', 'target ref moved; compare-and-swap refused', {
        action: 'replan_merge',
      })
    }
  }

  async function removeTempWorktree(
    token: string,
    tempPath: string,
    repoPath: string
  ): Promise<void> {
    const remove = await runGit(['worktree', 'remove', tempPath, '--force'], { cwd: repoPath })
    if (remove.exitCode !== 0) {
      rmSync(tempPath, { recursive: true, force: true })
    }
    await runGit(['worktree', 'prune'], { cwd: repoPath })
    updateRecord(token, { tempWorktreePath: undefined, tempBranchRef: undefined })
  }

  /** Resume a conflicted or interrupted merge after the user resolved it:
   *  commit the resolution in the retained temp worktree and publish. */
  async function resumeMerge(input: {
    recoveryToken: string
    resolved: boolean
  }): Promise<MergeOutcome> {
    const record = requireRecord(input.recoveryToken)
    if (record.state === 'merged') {
      return {
        state: 'merged',
        targetRef: record.targetRef ?? '',
        ...(record.squashedSha ? { publishedSha: record.squashedSha } : {}),
      }
    }
    if (!input.resolved) {
      return {
        state: 'conflicted',
        targetRef: record.targetRef ?? '',
        recoveryToken: record.token,
        tempWorktreePath: record.tempWorktreePath,
        instructions: `Resolve conflicts in ${record.tempWorktreePath}, then resume with resolved: true.`,
      }
    }
    if (!record.tempWorktreePath || !record.targetRef || !record.expectedTargetSha) {
      throw new WorktreeError('recovery_required', 'merge record has no retained temp worktree')
    }
    const add = await runGit(['add', '--all'], { cwd: record.tempWorktreePath })
    if (add.exitCode !== 0) {
      throw new WorktreeError('invalid_state', 'staging the resolved merge failed')
    }
    const commit = await runGit(['commit', '--no-verify', '-m', 'Merge resolution'], {
      cwd: record.tempWorktreePath,
    })
    if (commit.exitCode !== 0) {
      throw new WorktreeError('conflicted', 'the merge is not fully resolved')
    }
    const squashedSha = (
      await runGitChecked(['rev-parse', 'HEAD'], { cwd: record.tempWorktreePath })
    ).stdout.trim()
    updateRecord(record.token, { squashedSha })
    await publish(record.token, record.targetRef, record.expectedTargetSha, squashedSha)
    await removeTempWorktree(record.token, record.tempWorktreePath, record.repoPath)
    updateRecord(record.token, { state: 'merged' })
    return { state: 'merged', targetRef: record.targetRef, publishedSha: squashedSha }
  }

  /** Abort a conflicted merge: drop the retained temp worktree and the CAS
   *  reference. Never touches the target branch or the source checkout. */
  async function abortMerge(recoveryToken: string): Promise<{ aborted: boolean }> {
    const record = requireRecord(recoveryToken)
    if (record.tempWorktreePath) {
      await removeTempWorktree(record.token, record.tempWorktreePath, record.repoPath)
    }
    if (record.tempBranchRef) {
      await runGit(['update-ref', '-d', record.tempBranchRef], { cwd: record.repoPath })
    }
    updateRecord(record.token, { state: 'aborted' })
    return { aborted: true }
  }

  function requireRecord(token: string): MergeRecord {
    const record = records.load().records.find((entry) => entry.token === token)
    if (!record) throw new WorktreeError('not_found', 'merge recovery record not found')
    return record
  }

  function appendRecord(record: MergeRecord): void {
    const all = [...records.load().records]
    all.push(record)
    records.save(all)
  }

  function updateRecord(token: string, patch: Partial<MergeRecord>): void {
    const all = [...records.load().records]
    const record = all.find((entry) => entry.token === token)
    if (!record) return
    const index = all.indexOf(record)
    all[index] = { ...record, ...patch, updatedAt: nowIso(clock) }
    records.save(all)
  }

  return Object.freeze({
    planMerge,
    commitMerge,
    resumeMerge,
    abortMerge,
    deleteBranchIfUnchanged,
    DEFAULT_MERGE_STRATEGY,
  })
}
