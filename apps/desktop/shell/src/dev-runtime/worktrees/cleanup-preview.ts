// Read-only cleanup preview (M14.03.2, adea#1218).
//
// Deleting a worktree is destructive, so before any step runs the management
// surface shows exactly what the plan would do and what still blocks it. This
// module builds that preview from the same observations the executor uses and
// is deliberately pure:
//
// - `buildCleanupPreview` classifies a worktree as `clean`, `dirty` or
//   `sensitive` and enumerates the consequences of the selected steps. It
//   returns `executesNothing: true`; it cannot run a step, delete a folder or
//   touch git.
// - The interactive gate mirrors `commitCleanup`: a destructive step may only
//   run from a blocker-free plan, while a narrower plan (for example retaining
//   data only) remains available.
// - The automatic gate mirrors the cleanup-policy evaluator: a draft,
//   disabled/superseded (revoked) or expired policy authorizes nothing, the
//   policy may never select teardown or resource stops, and unsatisfied
//   predicates or missing facts fail closed.
// - `previewCleanupCommit` is the stale-write check: any fact that changed
//   between plan and commit produces `stale` with the exact field and a
//   `replan_cleanup` action instead of a retry. A crash leaves the durable
//   cleanup job; `previewCleanupRecovery` maps that job to resume or replan
//   without repeating a completed step.
import type { CleanupPredicate } from '../../../../../../packages/types/src/dev-runtime'

import { evaluatePredicates, type CleanupFacts as AutomaticCleanupFacts } from '../resources/policy'
import {
  computeCleanupBlockers,
  DESTRUCTIVE_CLEANUP_STEPS,
  factsChanged,
  type CleanupBlocker as PlanCleanupBlocker,
  type CleanupFacts,
  type CleanupStepKind,
} from './cleanup-plan'

/** The five steps an automatic policy may ever select; teardown and process
 *  stops always require a human in the current run (dev-runtime spec). */
export const AUTOMATIC_CLEANUP_STEPS: ReadonlyArray<CleanupStepKind> = [
  'quarantine_worktree',
  'unregister_worktree',
  'delete_quarantine',
  'delete_branch',
  'prune_retained_data',
]

export type CleanupConsequenceKind =
  | 'uncommitted_changes'
  | 'untracked_files'
  | 'merge_conflicts'
  | 'unpushed_commits'
  | 'unknown_push_state'
  | 'behind_remote'
  | 'protected_branch'
  | 'live_leases'
  | 'attached_owned_resources'
  | 'nested_worktrees'
  | 'external_ownership'
  | 'dangerous_path'
  | 'unproven_identity'
  | 'unusable_trash_root'
  | 'worktree_removal'
  | 'branch_deletion'
  | 'retained_data_prune'

export type CleanupConsequence = Readonly<{
  kind: CleanupConsequenceKind
  /** True when the fact blocks a destructive step outright. */
  blocking: boolean
  /** Bounded, path-free copy for the confirmation surface. */
  detail: string
}>

export type CleanupPreviewBlocker = Readonly<{
  code: string
  detail: string
  narrowable: boolean
}>

export type CleanupSensitivity = 'clean' | 'dirty' | 'sensitive'

function consequence(
  kind: CleanupConsequenceKind,
  detail: string,
  blocking = false
): CleanupConsequence {
  return Object.freeze({ kind, blocking, detail })
}

/**
 * Facts that lose work or leave the machine in a sensitive state. The
 * classification is presentation only: the blockers below remain the gate.
 */
export function cleanupConsequences(facts: CleanupFacts): CleanupConsequence[] {
  const list: CleanupConsequence[] = []
  if (facts.dirty) {
    list.push(consequence('uncommitted_changes', 'uncommitted changes', true))
  }
  if (facts.untracked) {
    list.push(consequence('untracked_files', 'untracked files', true))
  }
  if (facts.conflicted) {
    list.push(consequence('merge_conflicts', 'unresolved merge conflicts', true))
  }
  if (facts.unpushedCommits === null) {
    list.push(consequence('unknown_push_state', 'push state could not be measured', true))
  } else if (facts.unpushedCommits > 0) {
    list.push(consequence('unpushed_commits', `${facts.unpushedCommits} unpushed commit(s)`, true))
  }
  if (facts.behind === null) {
    list.push(consequence('behind_remote', 'behind state is unknown', true))
  }
  if (facts.isDefaultBranch || facts.isProtectedBranch) {
    list.push(consequence('protected_branch', 'the checked-out branch is protected', true))
  }
  if (facts.hasLiveLeases) {
    list.push(consequence('live_leases', 'active or suspect leases still hold this worktree', true))
  }
  for (const resource of facts.attachedOwnedResources) {
    list.push(
      consequence(
        'attached_owned_resources',
        `owned ${resource.kind} resource is still attached`,
        true
      )
    )
  }
  for (const nested of facts.nestedWorktrees) {
    list.push(
      consequence('nested_worktrees', `contains a nested registered worktree: ${nested}`, true)
    )
  }
  if (facts.provenance === 'external') {
    list.push(
      consequence('external_ownership', 'external worktrees are never managed-deleted', true)
    )
  }
  if (facts.dangerous) {
    list.push(consequence('dangerous_path', 'path is a dangerous deletion target', true))
  }
  if (!facts.identityProven || !facts.gitdirProven) {
    list.push(consequence('unproven_identity', 'worktree identity or gitdir is unproven', true))
  }
  if (!facts.trashRootUsable) {
    list.push(
      consequence('unusable_trash_root', 'the trash root is a symlink or not a directory', true)
    )
  }
  return list
}

/** The removal-side consequences of the steps actually selected. */
export function cleanupStepConsequences(
  selectedSteps: readonly CleanupStepKind[]
): CleanupConsequence[] {
  const selected = new Set(selectedSteps)
  const list: CleanupConsequence[] = []
  if (selected.has('quarantine_worktree') || selected.has('delete_quarantine')) {
    list.push(
      consequence('worktree_removal', 'the worktree folder is moved to quarantine and then removed')
    )
  }
  if (selected.has('delete_branch')) {
    list.push(consequence('branch_deletion', 'the worktree branch is deleted'))
  }
  if (selected.has('prune_retained_data')) {
    list.push(consequence('retained_data_prune', 'retained local data for the worktree is pruned'))
  }
  return list
}

function sensitivityOf(consequences: readonly CleanupConsequence[]): CleanupSensitivity {
  const blocking = consequences.filter((entry) => entry.blocking)
  if (blocking.length === 0) return 'clean'
  const sensitive = blocking.some((entry) =>
    (
      [
        'live_leases',
        'attached_owned_resources',
        'nested_worktrees',
        'external_ownership',
        'dangerous_path',
        'unproven_identity',
        'unusable_trash_root',
      ] as readonly CleanupConsequenceKind[]
    ).includes(entry.kind)
  )
  return sensitive ? 'sensitive' : 'dirty'
}

function previewBlockers(blockers: readonly PlanCleanupBlocker[]): CleanupPreviewBlocker[] {
  return blockers.map((blocker) =>
    Object.freeze({ code: blocker.code, detail: blocker.detail, narrowable: blocker.narrowable })
  )
}

export type InteractiveCleanupRefusal = 'nothing_selected' | 'cleanup_blocked'

export type CleanupPreview = Readonly<{
  worktreeId: string
  generation: number
  /** The preview is a read: no step, folder or git state changes. */
  executesNothing: true
  sensitivity: CleanupSensitivity
  consequences: readonly CleanupConsequence[]
  blockers: readonly CleanupPreviewBlocker[]
  selectedSteps: readonly CleanupStepKind[]
  interactive: Readonly<{
    allowed: boolean
    refusal?: InteractiveCleanupRefusal
    /** A plan that omits every destructive step is still runnable. */
    narrowable: boolean
  }>
}>

/**
 * The interactive gate, exactly mirroring `commitCleanup`: a selected
 * destructive step needs zero blockers; an empty selection is a refusal; a
 * non-destructive plan (for example `prune_retained_data` only) stays open.
 */
export function buildCleanupPreview(input: {
  facts: CleanupFacts
  selectedSteps: readonly CleanupStepKind[]
}): CleanupPreview {
  const blockers = computeCleanupBlockers(input.facts)
  const selected = [...new Set(input.selectedSteps)]
  const destructiveSelected = selected.some((step) => DESTRUCTIVE_CLEANUP_STEPS.includes(step))
  const consequences = [...cleanupConsequences(input.facts), ...cleanupStepConsequences(selected)]
  const refusal: InteractiveCleanupRefusal | undefined =
    selected.length === 0
      ? 'nothing_selected'
      : destructiveSelected && blockers.length > 0
        ? 'cleanup_blocked'
        : undefined
  return Object.freeze({
    worktreeId: input.facts.worktreeId,
    generation: input.facts.generation,
    executesNothing: true,
    sensitivity: sensitivityOf(consequences),
    consequences: Object.freeze(consequences),
    blockers: Object.freeze(previewBlockers(blockers)),
    selectedSteps: Object.freeze(selected),
    interactive: Object.freeze({
      allowed: refusal === undefined,
      ...(refusal ? { refusal } : {}),
      narrowable: destructiveSelected,
    }),
  })
}

export type CleanupCommitPreview =
  | Readonly<{ kind: 'runnable'; executesNothing: true }>
  | Readonly<{ kind: 'blocked'; executesNothing: true; blockerCodes: readonly string[] }>
  | Readonly<{
      kind: 'stale'
      executesNothing: true
      changedField: string
      action: 'replan_cleanup'
    }>
  | Readonly<{ kind: 'facts_unavailable'; executesNothing: true; action: 'replan_cleanup' }>

/**
 * Stale-write preview: re-observe at commit and report what changed before
 * any step runs. A changed fact or an unobservable worktree always produces
 * `replan_cleanup`; nothing is retried or force-applied from the old plan.
 */
export function previewCleanupCommit(input: {
  planned: CleanupPreview
  plannedFacts: CleanupFacts
  observed: CleanupFacts | null
}): CleanupCommitPreview {
  if (!input.observed) {
    return { kind: 'facts_unavailable', executesNothing: true, action: 'replan_cleanup' }
  }
  const changedField = factsChanged(input.plannedFacts, input.observed)
  if (changedField) {
    return { kind: 'stale', executesNothing: true, changedField, action: 'replan_cleanup' }
  }
  if (!input.planned.interactive.allowed || input.planned.blockers.length > 0) {
    return {
      kind: 'blocked',
      executesNothing: true,
      blockerCodes: input.planned.blockers.map((blocker) => blocker.code),
    }
  }
  return { kind: 'runnable', executesNothing: true }
}

export type AutomaticCleanupRefusal =
  | 'policy_unavailable'
  | 'policy_not_approved'
  | 'policy_expired'
  | 'policy_facts_unavailable'
  | 'policy_predicates_unmet'
  | 'automatic_step_denied'
  | 'automatic_confirmation_required'

export type AutomaticCleanupPreview = Readonly<{
  executesNothing: true
  allowed: boolean
  refusal?: AutomaticCleanupRefusal
  policyId?: string
  consequences: readonly CleanupConsequence[]
  blockers: readonly CleanupPreviewBlocker[]
}>

/**
 * The automatic gate, exactly mirroring the cleanup-policy evaluator: only an
 * approved, unexpired policy whose predicates every yield to current facts
 * may run, and only the five automatic steps. Missing facts and revoked
 * policies fail closed; the preview itself never executes anything.
 */
export function previewAutomaticCleanup(input: {
  policy: Readonly<{
    id: string
    state: 'draft' | 'approved' | 'disabled' | 'expired' | 'superseded'
    allowedSteps: readonly CleanupStepKind[]
    expiresAt?: string
  }> | null
  predicates: readonly CleanupPredicate[]
  facts: CleanupFacts | null
  automaticFacts: AutomaticCleanupFacts | null
  selectedSteps: readonly CleanupStepKind[]
  now?: Date
}): AutomaticCleanupPreview {
  if (!input.policy) {
    return {
      executesNothing: true,
      allowed: false,
      refusal: 'policy_unavailable',
      consequences: [],
      blockers: [],
    }
  }
  const policy = input.policy
  const now = (input.now ?? new Date()).getTime()
  const expired =
    policy.state === 'expired' ||
    (policy.expiresAt !== undefined && Number.isFinite(Date.parse(policy.expiresAt))
      ? Date.parse(policy.expiresAt) <= now
      : false)
  const baseConsequences = input.facts ? cleanupConsequences(input.facts) : []
  if (expired) {
    return {
      executesNothing: true,
      allowed: false,
      refusal: 'policy_expired',
      policyId: policy.id,
      consequences: baseConsequences,
      blockers: [],
    }
  }
  if (policy.state !== 'approved') {
    return {
      executesNothing: true,
      allowed: false,
      refusal: 'policy_not_approved',
      policyId: policy.id,
      consequences: baseConsequences,
      blockers: [],
    }
  }
  if (input.selectedSteps.some((step) => !AUTOMATIC_CLEANUP_STEPS.includes(step))) {
    return {
      executesNothing: true,
      allowed: false,
      refusal: 'automatic_step_denied',
      policyId: policy.id,
      consequences: baseConsequences,
      blockers: [],
    }
  }
  if (input.selectedSteps.some((step) => !policy.allowedSteps.includes(step))) {
    return {
      executesNothing: true,
      allowed: false,
      refusal: 'automatic_step_denied',
      policyId: policy.id,
      consequences: baseConsequences,
      blockers: [],
    }
  }
  if (!input.facts || !input.automaticFacts) {
    return {
      executesNothing: true,
      allowed: false,
      refusal: 'policy_facts_unavailable',
      policyId: policy.id,
      consequences: [],
      blockers: [],
    }
  }
  const evaluation = evaluatePredicates(input.predicates, input.automaticFacts)
  if (!evaluation.matched) {
    return {
      executesNothing: true,
      allowed: false,
      refusal: 'policy_predicates_unmet',
      policyId: policy.id,
      consequences: baseConsequences,
      blockers: Object.freeze(
        evaluation.blockers.map((blocker) =>
          Object.freeze({ code: blocker.code, detail: blocker.message, narrowable: false })
        )
      ),
    }
  }
  const blockers = computeCleanupBlockers(input.facts)
  if (blockers.length > 0) {
    return {
      executesNothing: true,
      allowed: false,
      refusal: 'automatic_confirmation_required',
      policyId: policy.id,
      consequences: [...baseConsequences, ...cleanupStepConsequences(input.selectedSteps)],
      blockers: Object.freeze(previewBlockers(blockers)),
    }
  }
  return {
    executesNothing: true,
    allowed: true,
    policyId: policy.id,
    consequences: [...baseConsequences, ...cleanupStepConsequences(input.selectedSteps)],
    blockers: [],
  }
}

export type CleanupRecoveryNextAction = 'none' | 'resume' | 'replan' | 'complete'

export type CleanupRecoveryPreview = Readonly<{
  executesNothing: true
  jobId?: string
  state:
    | 'none'
    | 'preflighted'
    | 'approved'
    | 'running'
    | 'blocked'
    | 'partial'
    | 'recovery_required'
    | 'completed'
    | 'failed'
  nextAction: CleanupRecoveryNextAction
  /** Journaled steps a resume must skip; never repeated. */
  completedSteps: readonly CleanupStepKind[]
}>

/**
 * Crash/retry preview. A durable job resumes from its journal, so completed
 * steps are excluded from the retry; a blocked or failed job is replanned
 * rather than force-run, and a completed job reports completion.
 */
export function previewCleanupRecovery(input: {
  job: Readonly<{
    jobId: string
    state:
      | 'preflighted'
      | 'approved'
      | 'running'
      | 'blocked'
      | 'partial'
      | 'recovery_required'
      | 'completed'
      | 'failed'
    completedSteps?: readonly CleanupStepKind[]
  }> | null
}): CleanupRecoveryPreview {
  const job = input.job
  if (!job) {
    return { executesNothing: true, state: 'none', nextAction: 'none', completedSteps: [] }
  }
  const completedSteps = Object.freeze([...(job.completedSteps ?? [])])
  const nextAction: CleanupRecoveryNextAction =
    job.state === 'completed'
      ? 'complete'
      : job.state === 'blocked' || job.state === 'failed'
        ? 'replan'
        : 'resume'
  return Object.freeze({
    executesNothing: true,
    jobId: job.jobId,
    state: job.state,
    nextAction,
    completedSteps,
  })
}
