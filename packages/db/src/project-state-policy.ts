// Explicit project-state promotion (M14.03.2, adea#1218).
//
// Archiving a project is a navigation state: its rows, members, channels and
// history stay. Bringing it back is a deliberate, opt-in promotion, never a
// side effect of a rename, a reorder or a lead tool call. This module is the
// policy and the one transactional implementation:
//
// - `decideProjectStatePromotion` is pure. It refuses a missing or foreign
//   project identically (existence never leaks), a soft-deleted project, an
//   already-active project, a stale observed revision and any call without an
//   explicit confirmation. `allowed` carries the exact visibility the
//   project already had, so promotion never widens or narrows the audience.
// - `promoteProjectState` applies the decision inside one transaction with a
//   compare-and-swap on the exact observed `updatedAt`, restores the channels
//   the archive cascade slept at +1 version, and appends `project.restored`
//   and `channel.restored` events. A failure rolls every step back, so a
//   retry after a crash re-reads and either promotes once or reports the
//   conflict; it never half-restores.
//
// The revision token is the row's `updatedAt` because the projects table has
// no version column yet. Concurrency is still exact for this flow: the row is
// locked (`for update`) for the decision and the update re-checks both the
// observed timestamp and the archived state. The coordination note
// `docs/plans/m14-03-management-action-contract.md` proposes the version column
// and the route that routes this through the shared audited API lane (#1215).
import type {
  ProjectLifecycleState,
  ProjectSummary,
  ProjectVisibility,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, eq, isNull } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { requireProjectAccessScope, requireProjectWrite } from './project-access'
import { channels, projects } from './schema'
import { appendWorkspaceEvent } from './transactions'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
  updatedAt: string
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
  expectedUpdatedAt: string
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

function refuse(reason: ProjectStatePromotionRefusal): never {
  throw new ProjectStatePromotionError(reason)
}

function isProjectId(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/**
 * The one promotion decision. Deterministic order: audience/non-disclosure
 * first, then lifecycle, then the stale-write token, then explicit opt-in, so
 * the same input always produces the same typed refusal.
 */
export function decideProjectStatePromotion(input: {
  project: ProjectStatePromotionObservation | null
  authorizedWorkspaceId: string
  expectedUpdatedAt: string
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
  if (
    input.expectedUpdatedAt.length < 1 ||
    !Number.isFinite(Date.parse(input.expectedUpdatedAt)) ||
    project.updatedAt !== input.expectedUpdatedAt
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
      expectedUpdatedAt: project.updatedAt,
    }),
  }
}

/** Mirrors the `projects` row projection for a summary. Local so this lane
 *  never edits the shared `projects.ts` summary mapper. */
function projectSummary(row: typeof projects.$inferSelect): ProjectSummary {
  return Object.freeze({
    createdAt: row.createdAt.toISOString(),
    iconKey: row.iconKey,
    id: row.id,
    lifecycleState: row.lifecycleState,
    name: row.name,
    sortOrder: row.sortOrder,
    sourceKind: row.sourceKind,
    updatedAt: row.updatedAt.toISOString(),
    visibility: row.visibility,
    workspaceId: row.workspaceId,
  })
}

/** Wake every channel the project archive cascade slept. A channel archived
 *  on its own before the project cannot be told apart from the cascade in the
 *  current schema, so promotion restores the project's archived channels and
 *  bumps each version; nothing is ever deleted. */
async function promoteProjectChannels(
  transaction: AgentHqTransaction,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef
): Promise<void> {
  const projectChannels = await transaction
    .select({ id: channels.id, version: channels.version })
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.projectId, projectId),
        eq(channels.lifecycleState, 'archived')
      )
    )
  for (const channel of projectChannels) {
    await transaction
      .update(channels)
      .set({ lifecycleState: 'active', updatedAt: new Date(), version: channel.version + 1 })
      .where(and(eq(channels.id, channel.id), eq(channels.workspaceId, workspaceId)))
    await appendWorkspaceEvent(transaction, {
      eventType: 'channel.restored',
      payload: { actorUserId: principal.userId, channelId: channel.id, projectId },
      workspaceId,
    })
  }
}

/**
 * Promote one archived project back to active. The caller must already hold
 * write access to the project (`requireProjectWrite`) and the observation
 * must be current; a stale token fails with `promotion_stale` and leaves the
 * archived row untouched.
 */
export async function promoteProjectState(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ confirmed: boolean; expectedUpdatedAt: string }>
): Promise<ProjectSummary> {
  if (!isProjectId(projectId)) refuse('project_unavailable')
  return database.transaction(async (transaction) => {
    const scope = await requireProjectAccessScope(
      transaction,
      workspaceId,
      principal,
      'Project unavailable'
    )
    requireProjectWrite(scope, projectId, 'Project unavailable')
    const [row] = await transaction
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .limit(1)
      .for('update')
    const decision = decideProjectStatePromotion({
      project: row
        ? {
            id: row.id,
            workspaceId: row.workspaceId,
            lifecycleState: row.lifecycleState,
            visibility: row.visibility,
            updatedAt: row.updatedAt.toISOString(),
            deletedAt: row.deletedAt?.toISOString() ?? null,
          }
        : null,
      authorizedWorkspaceId: workspaceId,
      expectedUpdatedAt: input.expectedUpdatedAt,
      confirmed: input.confirmed,
    })
    if (!decision.allowed) refuse(decision.reason)
    const plan = decision.plan
    // Channels first and the project row second: an interrupted transaction
    // rolls both back, and a successful one commits one coherent restore.
    await promoteProjectChannels(transaction, workspaceId, projectId, principal)
    const [updated] = await transaction
      .update(projects)
      .set({ lifecycleState: 'active', updatedAt: new Date() })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.workspaceId, workspaceId),
          eq(projects.lifecycleState, 'archived'),
          isNull(projects.deletedAt),
          eq(projects.updatedAt, new Date(plan.expectedUpdatedAt))
        )
      )
      .returning()
    // The row lock plus this compare-and-swap close the window between the
    // decision and the write; losing the race is a stale promotion.
    if (!updated) refuse('promotion_stale')
    await appendWorkspaceEvent(transaction, {
      eventType: 'project.restored',
      payload: { actorUserId: principal.userId, projectId },
      workspaceId,
    })
    return projectSummary(updated)
  })
}
