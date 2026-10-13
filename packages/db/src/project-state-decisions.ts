// Pure promotion decisions; database state changes stay in project-state-policy.
import type { ProjectLifecycleState, ProjectVisibility } from '@adea-ai/types'

export type ProjectStatePromotionRefusal =
  /** Absent, foreign or deleted: deliberately indistinguishable outside. */
  | 'project_unavailable'
  | 'promotion_deleted'
  | 'promotion_state_invalid'
  | 'promotion_stale'
  | 'promotion_not_confirmed'

/** The exact project state a promotion decision may observe. */
export type ProjectStatePromotionObservation = Readonly<{
  id: string
  workspaceId: string
  lifecycleState: ProjectLifecycleState
  visibility: ProjectVisibility
  /** The monotonic `projects.version`; the only revision authority. */
  version: number
  deletedAt: string | null
}>

export type ProjectStatePromotionPlan = Readonly<{
  projectId: string
  /** The workspace whose project is promoted; never re-derived from input. */
  audienceWorkspaceId: string
  /** The visibility is carried through promotion unchanged. */
  retainedVisibility: ProjectVisibility
  from: 'archived'
  to: 'active'
  expectedVersion: number
}>

export type ProjectStatePromotionDecision =
  | Readonly<{ allowed: true; plan: ProjectStatePromotionPlan }>
  | Readonly<{ allowed: false; reason: ProjectStatePromotionRefusal }>

const REFUSAL_MESSAGE: Readonly<Record<ProjectStatePromotionRefusal, string>> = {
  project_unavailable: 'Project unavailable',
  promotion_deleted: 'Project unavailable',
  promotion_state_invalid: 'Project state unchanged',
  promotion_stale: 'Project promotion conflict',
  promotion_not_confirmed: 'Project promotion not confirmed',
}

export class ProjectStatePromotionError extends Error {
  readonly reason: ProjectStatePromotionRefusal
  constructor(reason: ProjectStatePromotionRefusal) {
    super(REFUSAL_MESSAGE[reason])
    this.name = 'ProjectStatePromotionError'
    this.reason = reason
  }
}

/**
 * The one promotion decision. Deterministic order: audience/non-disclosure
 * first, then lifecycle, then the stale-write token, then explicit opt-in, so
 * the same input always produces the same typed refusal.
 */
export function decideProjectStatePromotion(input: {
  project: ProjectStatePromotionObservation | null
  authorizedWorkspaceId: string
  expectedVersion: number
  confirmed: boolean
}): ProjectStatePromotionDecision {
  const { project } = input
  if (!project || project.workspaceId !== input.authorizedWorkspaceId) {
    return { allowed: false, reason: 'project_unavailable' }
  }
  if (project.deletedAt !== null) return { allowed: false, reason: 'promotion_deleted' }
  if (project.lifecycleState !== 'archived') {
    return { allowed: false, reason: 'promotion_state_invalid' }
  }
  // A non-safe-integer, zero/negative or mismatched revision is unprovable:
  // it never counts as current.
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    project.version !== input.expectedVersion
  ) {
    return { allowed: false, reason: 'promotion_stale' }
  }
  if (input.confirmed !== true) return { allowed: false, reason: 'promotion_not_confirmed' }
  return {
    allowed: true,
    plan: Object.freeze({
      projectId: project.id,
      audienceWorkspaceId: project.workspaceId,
      retainedVisibility: project.visibility,
      from: 'archived',
      to: 'active',
      expectedVersion: project.version,
    }),
  }
}
