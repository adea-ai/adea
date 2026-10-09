// Cleanup preview gates (M14.03.2, adea#1218). Previews are pure and always
// `executesNothing`; these tests pin the two gate paths (interactive
// plan/commit and automatic cleanup policy), the stale-write refusal, the
// revoked/expired-policy refusals and the crash/retry mapping.
import { describe, expect, test } from 'bun:test'

import type { CleanupPredicate } from '../../../packages/types/src/dev-runtime'
import type { CleanupFacts } from '../shell/src/dev-runtime/worktrees/cleanup-plan'
import {
  AUTOMATIC_CLEANUP_STEPS,
  buildCleanupPreview,
  previewAutomaticCleanup,
  previewCleanupCommit,
  previewCleanupRecovery,
} from '../shell/src/dev-runtime/worktrees/cleanup-preview'

function facts(overrides: Partial<CleanupFacts> = {}): CleanupFacts {
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
    ...overrides,
  }
}

const ALL_STEPS = [
  'stop_owned_resource',
  'run_teardown',
  'quarantine_worktree',
  'unregister_worktree',
  'delete_quarantine',
  'delete_branch',
  'prune_retained_data',
] as const

const AUTOMATIC_FACTS: Record<string, string> = {
  active_leases: '0',
  active_owned_resources: '0',
  clean: 'true',
  pr_merged: 'true',
  pushed: 'true',
}

const AUTOMATIC_PREDICATES: readonly CleanupPredicate[] = [
  { kind: 'clean' },
  { kind: 'pushed' },
  { kind: 'pull_request_merged' },
  { kind: 'no_active_leases' },
  { kind: 'no_active_owned_resources' },
]

describe('interactive cleanup preview', () => {
  test('a clean worktree previews the removal consequences and allows the plan', () => {
    const preview = buildCleanupPreview({ facts: facts(), selectedSteps: ALL_STEPS })
    expect(preview.executesNothing).toBe(true)
    expect(preview.sensitivity).toBe('clean')
    expect(preview.interactive).toEqual({ allowed: true, narrowable: true })
    expect(preview.blockers).toEqual([])
    expect(preview.consequences.map((entry) => entry.kind)).toContain('worktree_removal')
    expect(preview.consequences.map((entry) => entry.kind)).toContain('branch_deletion')
  })

  test('a dirty worktree is classified dirty and blocked; the plan stays narrowable', () => {
    const preview = buildCleanupPreview({
      facts: facts({ dirty: true, unpushedCommits: 2, untracked: true }),
      selectedSteps: ALL_STEPS,
    })
    expect(preview.sensitivity).toBe('dirty')
    expect(preview.interactive).toEqual({
      allowed: false,
      refusal: 'cleanup_blocked',
      narrowable: true,
    })
    const kinds = preview.consequences.map((entry) => entry.kind)
    expect(kinds).toContain('uncommitted_changes')
    expect(kinds).toContain('untracked_files')
    expect(kinds).toContain('unpushed_commits')
    expect(preview.blockers.length).toBeGreaterThan(0)
    expect(preview.interactive.narrowable).toBe(true)
  })

  test('a sensitive worktree (leases, attached resources, external ownership) is classified sensitive', () => {
    const preview = buildCleanupPreview({
      facts: facts({
        attachedOwnedResources: [{ id: 'terminal-1', kind: 'terminal' }],
        hasLiveLeases: true,
        provenance: 'external',
      }),
      selectedSteps: ALL_STEPS,
    })
    expect(preview.sensitivity).toBe('sensitive')
    const kinds = preview.consequences.map((entry) => entry.kind)
    expect(kinds).toContain('attached_owned_resources')
    expect(kinds).toContain('live_leases')
    expect(kinds).toContain('external_ownership')
    expect(preview.blockers.some((blocker) => !blocker.narrowable)).toBe(true)
  })

  test('an empty selection refuses; a non-destructive plan stays allowed under blockers', () => {
    const empty = buildCleanupPreview({ facts: facts(), selectedSteps: [] })
    expect(empty.interactive).toEqual({
      allowed: false,
      refusal: 'nothing_selected',
      narrowable: false,
    })
    const narrow = buildCleanupPreview({
      facts: facts({ dirty: true }),
      selectedSteps: ['prune_retained_data'],
    })
    expect(narrow.interactive.allowed).toBe(true)
    expect(narrow.consequences.map((entry) => entry.kind)).toContain('retained_data_prune')
  })

  test('a stale write refuses at commit with the changed field and replan action', () => {
    const plannedFacts = facts()
    const preview = buildCleanupPreview({ facts: plannedFacts, selectedSteps: ALL_STEPS })
    expect(
      previewCleanupCommit({ planned: preview, plannedFacts, observed: plannedFacts })
    ).toEqual({ kind: 'runnable', executesNothing: true })
    expect(
      previewCleanupCommit({
        planned: preview,
        plannedFacts,
        observed: facts({ dirty: true }),
      })
    ).toEqual({
      kind: 'stale',
      executesNothing: true,
      changedField: 'dirty',
      action: 'replan_cleanup',
    })
    expect(
      previewCleanupCommit({
        planned: preview,
        plannedFacts,
        observed: facts({ attachedOwnedResources: [{ id: 'terminal-1', kind: 'terminal' }] }),
      })
    ).toEqual({
      kind: 'stale',
      executesNothing: true,
      changedField: 'attachedOwnedResources',
      action: 'replan_cleanup',
    })
    expect(previewCleanupCommit({ planned: preview, plannedFacts, observed: null })).toEqual({
      kind: 'facts_unavailable',
      executesNothing: true,
      action: 'replan_cleanup',
    })
  })

  test('the blocked preview never becomes runnable through a commit', () => {
    const plannedFacts = facts({ dirty: true })
    const preview = buildCleanupPreview({ facts: plannedFacts, selectedSteps: ALL_STEPS })
    const commit = previewCleanupCommit({ planned: preview, plannedFacts, observed: plannedFacts })
    expect(commit.kind).toBe('blocked')
    if (commit.kind === 'blocked') expect(commit.blockerCodes).toContain('dirty')
  })
})

describe('automatic cleanup preview', () => {
  const policy = {
    allowedSteps: AUTOMATIC_CLEANUP_STEPS,
    id: 'policy-1',
    state: 'approved' as const,
  }

  function automatic(overrides: Partial<Parameters<typeof previewAutomaticCleanup>[0]> = {}) {
    return previewAutomaticCleanup({
      automaticFacts: AUTOMATIC_FACTS,
      facts: facts(),
      policy,
      predicates: AUTOMATIC_PREDICATES,
      selectedSteps: ['quarantine_worktree', 'delete_quarantine'],
      ...overrides,
    })
  }

  test('an approved policy with satisfied predicates previews the run and still executes nothing', () => {
    const preview = automatic()
    expect(preview).toMatchObject({
      allowed: true,
      executesNothing: true,
      policyId: 'policy-1',
    })
    expect(preview.consequences.map((entry) => entry.kind)).toContain('worktree_removal')
  })

  test('a revoked, disabled or expired policy authorizes nothing', () => {
    expect(automatic({ policy: null })).toMatchObject({
      allowed: false,
      refusal: 'policy_unavailable',
    })
    expect(automatic({ policy: { ...policy, state: 'draft' } })).toMatchObject({
      allowed: false,
      refusal: 'policy_not_approved',
    })
    expect(automatic({ policy: { ...policy, state: 'disabled' } })).toMatchObject({
      allowed: false,
      refusal: 'policy_not_approved',
    })
    expect(automatic({ policy: { ...policy, state: 'superseded' } })).toMatchObject({
      allowed: false,
      refusal: 'policy_not_approved',
    })
    expect(automatic({ policy: { ...policy, state: 'expired' } })).toMatchObject({
      allowed: false,
      refusal: 'policy_expired',
    })
    const expiredAt = new Date(Date.now() - 60_000).toISOString()
    expect(automatic({ policy: { ...policy, expiresAt: expiredAt } })).toMatchObject({
      allowed: false,
      refusal: 'policy_expired',
    })
  })

  test('teardown and process stops are never automatic; unlisted steps are denied', () => {
    expect(AUTOMATIC_CLEANUP_STEPS).not.toContain('run_teardown')
    expect(AUTOMATIC_CLEANUP_STEPS).not.toContain('stop_owned_resource')
    expect(automatic({ selectedSteps: ['run_teardown'] })).toMatchObject({
      allowed: false,
      refusal: 'automatic_step_denied',
    })
    expect(automatic({ selectedSteps: ['stop_owned_resource'] })).toMatchObject({
      allowed: false,
      refusal: 'automatic_step_denied',
    })
    expect(
      automatic({
        policy: { ...policy, allowedSteps: ['prune_retained_data'] },
        selectedSteps: ['delete_branch'],
      })
    ).toMatchObject({ allowed: false, refusal: 'automatic_step_denied' })
  })

  test('missing facts and unsatisfied predicates fail closed', () => {
    expect(automatic({ automaticFacts: null })).toMatchObject({
      allowed: false,
      refusal: 'policy_facts_unavailable',
    })
    expect(automatic({ facts: null })).toMatchObject({
      allowed: false,
      refusal: 'policy_facts_unavailable',
    })
    expect(automatic({ automaticFacts: { ...AUTOMATIC_FACTS, clean: 'false' } })).toMatchObject({
      allowed: false,
      refusal: 'policy_predicates_unmet',
    })
    const unmet = automatic({ automaticFacts: { ...AUTOMATIC_FACTS, pushed: 'false' } })
    expect(unmet.refusal).toBe('policy_predicates_unmet')
    expect(unmet.blockers.some((blocker) => blocker.code === 'unpushed')).toBe(true)
  })

  test('ordinary cleanup blockers still require confirmation even when predicates pass', () => {
    const preview = automatic({ facts: facts({ hasLiveLeases: true }) })
    expect(preview).toMatchObject({
      allowed: false,
      refusal: 'automatic_confirmation_required',
    })
    expect(preview.blockers.some((blocker) => blocker.code === 'leased')).toBe(true)
  })
})

describe('cleanup recovery preview', () => {
  test('a crashed or interrupted job resumes without repeating completed steps', () => {
    expect(previewCleanupRecovery({ job: null })).toEqual({
      executesNothing: true,
      nextAction: 'none',
      state: 'none',
      completedSteps: [],
    })
    expect(
      previewCleanupRecovery({
        job: {
          completedSteps: ['quarantine_worktree', 'unregister_worktree'],
          jobId: 'job-1',
          state: 'recovery_required',
        },
      })
    ).toEqual({
      executesNothing: true,
      jobId: 'job-1',
      nextAction: 'resume',
      state: 'recovery_required',
      completedSteps: ['quarantine_worktree', 'unregister_worktree'],
    })
    expect(previewCleanupRecovery({ job: { jobId: 'job-2', state: 'blocked' } })).toMatchObject({
      nextAction: 'replan',
    })
    expect(previewCleanupRecovery({ job: { jobId: 'job-3', state: 'failed' } })).toMatchObject({
      nextAction: 'replan',
    })
    expect(
      previewCleanupRecovery({
        job: { completedSteps: ALL_STEPS, jobId: 'job-4', state: 'completed' },
      })
    ).toMatchObject({ nextAction: 'complete', state: 'completed' })
  })
})
