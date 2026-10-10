// Explicit project-state promotion and the canonical project/channel state
// transitions (M14.03.2, adea#1218).
//
// Archiving a project is a navigation state: its rows, members, channels and
// history stay. Bringing it back is a deliberate, opt-in promotion, never a
// side effect of a rename, a reorder or a lead tool call. This module is the
// policy and the canonical implementation:
//
// - `decideProjectStatePromotion` is pure. It refuses a missing or foreign
//   project identically (existence never leaks), a soft-deleted project, an
//   already-active project, a stale observed revision and any call without an
//   explicit confirmation. `allowed` carries the exact visibility the
//   project already had, so promotion never widens or narrows the audience.
// - `archiveProjectChannels` and `restoreProjectChannels` are the one
//   channel-cascade implementation shared by archive, soft delete and
//   promotion. Both lock the project row first and the project's channels in
//   id order, then compare-and-swap each channel's `version`, so concurrent
//   state changes serialize in one lock order and a moved row aborts the
//   whole transaction instead of writing a lost update.
// - Channel archive provenance is explicit: the project cascade marks each
//   channel it sleeps `project_cascade`, and promotion wakes exactly that set
//   at +1 version. A channel archived independently carries `individual` and
//   is never silently revived by a project promotion; it is restored only by
//   an explicit individual channel action.
// - `promoteProjectState` applies the decision inside one transaction with a
//   compare-and-swap on the exact observed `updatedAt` and appends
//   `project.restored` / `channel.restored` events. A failure rolls every
//   step back, so a retry after a crash re-reads and either promotes once or
//   reports the conflict; it never half-restores.
//
// The project revision token is the row's `updatedAt` because the projects
// table has no version column yet; the row lock plus the compare-and-swap is
// exact for this flow. `docs/plans/m14-03-management-action-contract.md`
// records the proposed `projects.version` hardening.
import type {
  ProjectLifecycleState,
  ProjectSummary,
  ProjectVisibility,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { requireProjectAccessScope, requireProjectWrite } from './project-access'
import { projectSummary } from './project-summary'
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
 * A project or channel row moved between the observation and its versioned
 * write. The transaction rolls back; a retry re-observes instead of writing a
 * lost update.
 */
export class ProjectStateConflictError extends Error {
  constructor() {
    super('Project state conflict')
    this.name = 'ProjectStateConflictError'
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

/**
 * Lock the project row before any channel row. Archive, soft delete and
 * promotion all take the project lock first and then channels in id order, so
 * concurrent state changes serialize in one lock order instead of racing or
 * deadlocking.
 */
export async function lockProjectForStateChange(
  transaction: AgentHqTransaction,
  workspaceId: string,
  projectId: string
): Promise<typeof projects.$inferSelect> {
  const [row] = await transaction
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)
    .for('update')
  if (!row) throw new Error('Project unavailable')
  return row
}

/**
 * Archive every active channel of a project as the project cascade. The set
 * is marked `project_cascade` so a later promotion knows exactly which
 * channels it may wake; channels already archived individually stay
 * `individual`. Each write bumps `version` only from the observed value.
 */
export async function archiveProjectChannels(
  transaction: AgentHqTransaction,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef
): Promise<number> {
  const projectChannels = await transaction
    .select({ id: channels.id, version: channels.version })
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.projectId, projectId),
        eq(channels.lifecycleState, 'active')
      )
    )
    .orderBy(asc(channels.id))
    .for('update')
  for (const channel of projectChannels) {
    const [archived] = await transaction
      .update(channels)
      .set({
        archiveSource: 'project_cascade',
        lifecycleState: 'archived',
        updatedAt: new Date(),
        version: channel.version + 1,
      })
      .where(
        and(
          eq(channels.id, channel.id),
          eq(channels.workspaceId, workspaceId),
          eq(channels.lifecycleState, 'active'),
          eq(channels.version, channel.version)
        )
      )
      .returning({ id: channels.id })
    if (!archived) throw new ProjectStateConflictError()
    await appendWorkspaceEvent(transaction, {
      eventType: 'channel.archived',
      payload: { actorUserId: principal.userId, channelId: channel.id, projectId },
      workspaceId,
    })
  }
  return projectChannels.length
}

/**
 * Wake exactly the channels the project-archive cascade slept. Independent
 * archives carried `individual` provenance and are left untouched, so a
 * project promotion can never resurrect a channel the user archived on its
 * own. The restored row resets to `individual` and bumps `version` only from
 * the observed value.
 */
export async function restoreProjectChannels(
  transaction: AgentHqTransaction,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef
): Promise<number> {
  const projectChannels = await transaction
    .select({ id: channels.id, version: channels.version })
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.projectId, projectId),
        eq(channels.lifecycleState, 'archived'),
        eq(channels.archiveSource, 'project_cascade')
      )
    )
    .orderBy(asc(channels.id))
    .for('update')
  for (const channel of projectChannels) {
    const [restored] = await transaction
      .update(channels)
      .set({
        archiveSource: 'individual',
        lifecycleState: 'active',
        updatedAt: new Date(),
        version: channel.version + 1,
      })
      .where(
        and(
          eq(channels.id, channel.id),
          eq(channels.workspaceId, workspaceId),
          eq(channels.lifecycleState, 'archived'),
          eq(channels.archiveSource, 'project_cascade'),
          eq(channels.version, channel.version)
        )
      )
      .returning({ id: channels.id })
    if (!restored) throw new ProjectStateConflictError()
    await appendWorkspaceEvent(transaction, {
      eventType: 'channel.restored',
      payload: { actorUserId: principal.userId, channelId: channel.id, projectId },
      workspaceId,
    })
  }
  return projectChannels.length
}

/**
 * Promote one archived project back to active. The caller must already hold
 * write access to the project (`requireProjectWrite`) and the observation
 * must be current; a stale revision fails with `promotion_stale` and leaves
 * the archived row and its channels untouched. The promoted row increments
 * `version` atomically with the CAS, so no later write can reuse the token.
 */
export async function promoteProjectState(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ confirmed: boolean; expectedVersion: number }>
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
    const row = await lockProjectForStateChange(transaction, workspaceId, projectId)
    const decision = decideProjectStatePromotion({
      project: {
        id: row.id,
        workspaceId: row.workspaceId,
        lifecycleState: row.lifecycleState,
        visibility: row.visibility,
        version: row.version,
        deletedAt: row.deletedAt?.toISOString() ?? null,
      },
      authorizedWorkspaceId: workspaceId,
      expectedVersion: input.expectedVersion,
      confirmed: input.confirmed,
    })
    if (!decision.allowed) refuse(decision.reason)
    const plan = decision.plan
    // Channels first and the project row second: an interrupted transaction
    // rolls both back, and a successful one commits one coherent restore.
    await restoreProjectChannels(transaction, workspaceId, projectId, principal)
    const [updated] = await transaction
      .update(projects)
      .set({
        lifecycleState: 'active',
        updatedAt: new Date(),
        version: sql`${projects.version} + 1`,
      })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.workspaceId, workspaceId),
          eq(projects.lifecycleState, 'archived'),
          isNull(projects.deletedAt),
          eq(projects.version, plan.expectedVersion)
        )
      )
      .returning()
    // The row lock plus this integer compare-and-swap close the window
    // between the decision and the write; losing the race is a stale
    // promotion.
    if (!updated) refuse('promotion_stale')
    await appendWorkspaceEvent(transaction, {
      eventType: 'project.restored',
      payload: { actorUserId: principal.userId, projectId },
      workspaceId,
    })
    return projectSummary(updated)
  })
}
