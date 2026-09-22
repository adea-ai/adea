// Cleanup preflight: pure blocker computation over observed facts.
//
// `Complete and clean` refuses destructive steps unless every blocking fact is
// resolved or the user deliberately selects a narrower plan. The plan carries
// immutable observed facts plus a digest; commit refuses if any fact changed
// between plan and commit. Expiry, suspect state, and unknown facts grant no
// authority — they are blockers, exactly like dirty or unpushed state.
import { createHash } from 'node:crypto'

import type { WorktreeErrorCode } from './errors'

export type CleanupFacts = Readonly<{
  worktreeId: string
  generation: number
  provenance: 'adea' | 'external'
  lifecycle: string
  canonicalRoot: string
  repoPath: string
  headBranch?: string
  branchRef?: string
  headSha?: string
  /** Working tree has modified tracked files. */
  dirty: boolean
  /** Working tree has untracked files. */
  untracked: boolean
  conflicted: boolean
  /** Upstream known; when false, ahead/behind are unknown. */
  upstreamKnown: boolean
  ahead: number | null
  behind: number | null
  /** Commits on the branch that no remote ref contains. */
  unpushedCommits: number
  isDefaultBranch: boolean
  isProtectedBranch: boolean
  hasLiveLeases: boolean
  /** Adea-owned resources (terminals, harness runs, servers) still attached. */
  attachedOwnedResources: ReadonlyArray<Readonly<{ id: string; kind: string }>>
  /** Registered worktrees whose path is inside this one. */
  nestedWorktrees: ReadonlyArray<string>
  /** Canonical path + directory identity + gitdir backlink all proven just now. */
  identityProven: boolean
  gitdirProven: boolean
  dangerous: boolean
  trashRootUsable: boolean
}>

export type CleanupBlocker = Readonly<{
  code: WorktreeErrorCode
  detail: string
  /** True when the user may deliberately narrow the plan instead of resolving
   *  the underlying condition (e.g. archive-without-delete alternatives). */
  narrowable: boolean
}>

export const CLEANUP_STEP_KINDS = [
  'stop_owned_resource',
  'run_teardown',
  'quarantine_worktree',
  'unregister_worktree',
  'delete_quarantine',
  'delete_branch',
  'prune_retained_data',
] as const

export type CleanupStepKind = (typeof CLEANUP_STEP_KINDS)[number]

const HARD_BLOCKERS: ReadonlyArray<CleanupBlocker> = [
  {
    code: 'external_ownership',
    detail: 'external worktrees are never managed-deleted',
    narrowable: false,
  },
]

export function computeCleanupBlockers(facts: CleanupFacts): CleanupBlocker[] {
  const blockers: CleanupBlocker[] = []
  const add = (code: WorktreeErrorCode, detail: string, narrowable = false) =>
    blockers.push({ code, detail, narrowable })

  if (!facts.identityProven) add('identity_mismatch', 'worktree path/identity is unproven')
  if (!facts.gitdirProven) add('gitdir_unproven', 'gitdir backlink could not be proven')
  if (facts.provenance === 'external') {
    blockers.push(...HARD_BLOCKERS)
  }
  if (facts.dangerous) add('dangerous_path', 'path is a dangerous deletion target')
  if (!facts.trashRootUsable) add('dangerous_path', 'trash root is a symlink or not a directory')
  if (facts.dirty) add('dirty', 'working tree has uncommitted modifications')
  if (facts.untracked) add('dirty', 'working tree has untracked files')
  if (facts.conflicted) add('conflicted', 'merge conflicts are unresolved')
  if (!facts.upstreamKnown) add('unpushed', 'no upstream is configured; push state is unknown')
  else {
    if ((facts.ahead ?? 0) > 0 || facts.unpushedCommits > 0) {
      add('unpushed', 'the branch has unpushed commits')
    }
    if (facts.behind === null) add('behind', 'behind state is unknown')
  }
  if (facts.isDefaultBranch) add('protected_branch', 'the checked-out branch is the default branch')
  if (facts.isProtectedBranch) add('protected_branch', 'the checked-out branch is protected')
  if (facts.hasLiveLeases) add('leased', 'active or suspect leases still hold this worktree')
  if (facts.attachedOwnedResources.length > 0) {
    add('leased', `${facts.attachedOwnedResources.length} owned resource(s) are still attached`)
  }
  if (facts.nestedWorktrees.length > 0) {
    add('nested_worktree', `contains ${facts.nestedWorktrees.length} nested registered worktree(s)`)
  }
  if (facts.lifecycle === 'archived') {
    // Archived is a navigation state only; it neither blocks nor authorizes.
  }
  return blockers
}

export type CleanupPlan = Readonly<{
  planId: string
  worktreeId: string
  generation: number
  facts: CleanupFacts
  blockers: ReadonlyArray<CleanupBlocker>
  /** Steps the user selected. Destructive steps require zero blockers. */
  selectedSteps: ReadonlyArray<CleanupStepKind>
  selectedResourceIds: ReadonlyArray<string>
  digest: string
  createdAt: string
}>

export type CleanupResult = Readonly<{
  planId: string
  worktreeId: string
  state: 'completed' | 'partial' | 'blocked' | 'recovery_required'
  stepResults: ReadonlyArray<
    Readonly<{
      step: CleanupStepKind
      state: 'completed' | 'skipped' | 'failed' | 'rolled_back'
      detail?: string
    }>
  >
}>

export function planDigestOf(plan: Omit<CleanupPlan, 'digest' | 'createdAt'>): string {
  return createHash('sha256').update(canonicalPlanJson(plan)).digest('hex')
}

export function canonicalPlanJson(plan: Omit<CleanupPlan, 'digest' | 'createdAt'>): string {
  return JSON.stringify({
    planId: plan.planId,
    worktreeId: plan.worktreeId,
    generation: plan.generation,
    facts: plan.facts,
    blockers: plan.blockers,
    selectedSteps: plan.selectedSteps.toSorted(),
    selectedResourceIds: plan.selectedResourceIds.toSorted(),
  })
}

/** Build a plan from facts. The plan carries its blockers so the caller can
 *  display exactly what blocks destructive steps; committing a plan whose
 *  destructive steps meet blockers is refused by the executor. */
export const DESTRUCTIVE_CLEANUP_STEPS: ReadonlyArray<CleanupStepKind> = [
  'stop_owned_resource',
  'run_teardown',
  'quarantine_worktree',
  'unregister_worktree',
  'delete_quarantine',
  'delete_branch',
]

export function buildCleanupPlan(input: {
  planId: string
  facts: CleanupFacts
  selectedSteps: ReadonlyArray<CleanupStepKind>
  selectedResourceIds?: ReadonlyArray<string>
  clock?: () => Date
}): CleanupPlan {
  const blockers = computeCleanupBlockers(input.facts)
  const selected = [...new Set(input.selectedSteps)]
  const fields = {
    planId: input.planId,
    worktreeId: input.facts.worktreeId,
    generation: input.facts.generation,
    facts: input.facts,
    blockers,
    selectedSteps: selected,
    selectedResourceIds: input.selectedResourceIds ?? [],
  }
  return {
    ...fields,
    digest: planDigestOf(fields),
    createdAt: (input.clock ?? (() => new Date()))().toISOString(),
  }
}

/** Commit-time fact revalidation: any drift between the planned facts and the
 *  facts observed at commit is a refusal. */
export function factsChanged(planned: CleanupFacts, observed: CleanupFacts): string | null {
  const fields: ReadonlyArray<keyof CleanupFacts> = [
    'worktreeId',
    'generation',
    'provenance',
    'dirty',
    'untracked',
    'conflicted',
    'upstreamKnown',
    'ahead',
    'behind',
    'unpushedCommits',
    'isDefaultBranch',
    'isProtectedBranch',
    'hasLiveLeases',
    'identityProven',
    'gitdirProven',
    'dangerous',
    'trashRootUsable',
  ]
  for (const field of fields) {
    if (JSON.stringify(planned[field]) !== JSON.stringify(observed[field])) {
      return field
    }
  }
  const plannedAttached = planned.attachedOwnedResources
    .map((entry) => entry.id)
    .toSorted()
    .join(',')
  const observedAttached = observed.attachedOwnedResources
    .map((entry) => entry.id)
    .toSorted()
    .join(',')
  if (plannedAttached !== observedAttached) return 'attachedOwnedResources'
  const plannedNested = planned.nestedWorktrees.toSorted().join(',')
  const observedNested = observed.nestedWorktrees.toSorted().join(',')
  if (plannedNested !== observedNested) return 'nestedWorktrees'
  return null
}
