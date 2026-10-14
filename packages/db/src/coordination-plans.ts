/*
 * Coordination plans that cite separately owned jobs (M15.03 #1217).
 *
 * Adea owns the plan, scoped to one group channel and its workspace. A revision is an ordered,
 * deduplicated list of at most 50 job ids and nothing else: no copied titles, no private context,
 * no source credentials, no generated summary. A citation is a pointer. It never moves the job,
 * never becomes a task dependency, and grants no authority to read, change, cancel, complete or
 * run the job. What a reader learns of a cited job is decided at read time by
 * `resolveJobReferences`, which applies the canonical publication gate and the reader's history
 * window. This module adds no authority rule of its own.
 *
 * Writing. Creating or revising a plan is a group-channel write, so the actor, derived from the
 * authenticated principal and never from the request, needs the same standing as posting a
 * message: workspace membership, project write access, and a live participation grant checked
 * under the channel lock. Group membership confers no authority in a job's source workspace, so a
 * citation that is new to the plan must already be released to that actor in this channel. The
 * check runs in the write transaction and its locks are held to commit: a revocation that commits
 * afterwards orders after the plan, and every later read reflects it. A citation carried over from
 * the previous revision is not rechecked. It is only a pointer, and each reader's resolution
 * decides what it shows.
 *
 * Revisions. They increase by one. A revision is written with the revision the writer last saw;
 * a stale writer is refused and nothing changes. An accepted revision and its citations are
 * immutable at the database (migration 0056), so a change is always a new revision.
 *
 * Reading. A plan revision is read for one reader, who must hold current read access to the
 * channel. Historical revisions are read with current authority: revocation, roster changes and
 * the reader's join point apply to old revisions exactly as to new ones.
 *
 * Every failure that could tell a caller whether a job, plan or channel exists is the same
 * `unavailable` error, so none of them can be told apart.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, asc, eq } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { requireChannelAccess, requireGroupMutationStanding } from './conversations'
import {
  JOB_REFERENCE_MAX_BATCH,
  resolveJobReferences,
  type JobReferenceView,
} from './job-outbound-reference'
import { coordinationPlanCitations, coordinationPlanRevisions, coordinationPlans } from './schema'

type Database = AgentHqDatabase | AgentHqTransaction

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_REVISION = 2_147_483_647

/** A plan holds at most this many distinct cited jobs per revision. */
export const COORDINATION_PLAN_MAX_CITATIONS = JOB_REFERENCE_MAX_BATCH

/** What a writer receives for an accepted revision. The ids are the ones the writer supplied. */
export type CoordinationPlanRevisionView = Readonly<{
  createdAt: string
  jobIds: readonly string[]
  planId: string
  revision: number
}>

export type CoordinationPlanReferences = Readonly<{
  planId: string
  references: readonly JobReferenceView[]
  revision: number
}>

/**
 * The ordered, lowercase, deduplicated job ids of a request. A repeated id keeps its first
 * position. Anything that is not a UUID, or more than the bound after deduplication, is refused
 * whole: a plan is never saved from part of what was asked.
 */
export function normalizePlanJobIds(jobIds: unknown): string[] {
  if (!Array.isArray(jobIds)) throw new Error('Plan citations invalid')
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const jobId of jobIds) {
    if (typeof jobId !== 'string' || !UUID.test(jobId)) throw new Error('Plan citations invalid')
    const id = jobId.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
    if (ordered.length > COORDINATION_PLAN_MAX_CITATIONS) throw new Error('Plan citations invalid')
  }
  return ordered
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_REVISION
}

function requestHash(actor: UserPrincipalRef, jobIds: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ actorUserId: actor.userId, jobIds }))
    .digest('hex')
}

/** Write standing in a group channel: the same gates a message post passes, under the locks. */
async function requirePlanWriter(
  transaction: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  actor: UserPrincipalRef
): Promise<void> {
  const channel = await requireChannelAccess(transaction, workspaceId, channelId, actor, 'write')
  // Plans are scoped to group channels. Any other channel answers like a missing one.
  if (channel.kind !== 'group') throw new Error('Channel unavailable')
  await requireGroupMutationStanding(transaction, workspaceId, channelId, actor)
}

/** Every id must be released to the actor in this channel now, or none is cited. */
async function requireReleasedCitations(
  transaction: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  actor: UserPrincipalRef,
  jobIds: readonly string[]
): Promise<void> {
  if (!jobIds.length) return
  const views = await resolveJobReferences(transaction, {
    channelId,
    jobIds,
    // A sharing grant revoked before this transaction commits must not validate the citation.
    lockHistory: true,
    reader: actor,
    workspaceId,
  })
  if (views.length !== jobIds.length || views.some((view) => view.availability !== 'available'))
    throw new Error('Plan citation unavailable')
}

async function insertRevision(
  transaction: AgentHqTransaction,
  plan: Readonly<{ channelId: string; id: string; workspaceId: string }>,
  revision: number,
  authorUserId: string,
  jobIds: readonly string[]
): Promise<CoordinationPlanRevisionView> {
  const [created] = await transaction
    .insert(coordinationPlanRevisions)
    .values({
      authorUserId,
      channelId: plan.channelId,
      citationCount: jobIds.length,
      planId: plan.id,
      revision,
      workspaceId: plan.workspaceId,
    })
    .returning({ createdAt: coordinationPlanRevisions.createdAt })
  if (!created) throw new Error('Plan unavailable')
  if (jobIds.length)
    await transaction.insert(coordinationPlanCitations).values(
      jobIds.map((jobId, position) => ({
        jobId,
        planId: plan.id,
        position,
        revision,
      }))
    )
  return { createdAt: created.createdAt.toISOString(), jobIds, planId: plan.id, revision }
}

async function readCitedJobIds(
  database: Database,
  planId: string,
  revision: number
): Promise<string[]> {
  const rows = await database
    .select({ jobId: coordinationPlanCitations.jobId })
    .from(coordinationPlanCitations)
    .where(
      and(
        eq(coordinationPlanCitations.planId, planId),
        eq(coordinationPlanCitations.revision, revision)
      )
    )
    .orderBy(asc(coordinationPlanCitations.position))
  return rows.map((row) => row.jobId)
}

/**
 * Creates a plan at revision 1. A replay of the same key and request returns the revision it
 * created. The same key with another request, or by another actor, is a conflict.
 */
export async function createCoordinationPlan(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  actor: UserPrincipalRef,
  input: Readonly<{ idempotencyKey: string; jobIds: readonly string[] }>
): Promise<CoordinationPlanRevisionView> {
  const idempotencyKey = input.idempotencyKey.trim()
  if (!idempotencyKey || idempotencyKey.length > 128) throw new Error('Plan citations invalid')
  const jobIds = normalizePlanJobIds(input.jobIds)
  const payloadHash = requestHash(actor, jobIds)
  return database.transaction(async (transaction) => {
    await requirePlanWriter(transaction, workspaceId, channelId, actor)
    const replay = async (): Promise<CoordinationPlanRevisionView | null> => {
      const [existing] = await transaction
        .select()
        .from(coordinationPlans)
        .where(
          and(
            eq(coordinationPlans.workspaceId, workspaceId),
            eq(coordinationPlans.channelId, channelId),
            eq(coordinationPlans.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1)
      if (!existing) return null
      if (existing.createPayloadHash !== payloadHash) throw new Error('Plan idempotency conflict')
      const [first] = await transaction
        .select({ createdAt: coordinationPlanRevisions.createdAt })
        .from(coordinationPlanRevisions)
        .where(
          and(
            eq(coordinationPlanRevisions.planId, existing.id),
            eq(coordinationPlanRevisions.revision, 1)
          )
        )
      if (!first) throw new Error('Plan unavailable')
      return {
        createdAt: first.createdAt.toISOString(),
        jobIds: await readCitedJobIds(transaction, existing.id, 1),
        planId: existing.id,
        revision: 1,
      }
    }
    const replayed = await replay()
    if (replayed) return replayed
    await requireReleasedCitations(transaction, workspaceId, channelId, actor, jobIds)
    const [plan] = await transaction
      .insert(coordinationPlans)
      .values({
        channelId,
        createPayloadHash: payloadHash,
        createdByUserId: actor.userId,
        currentRevision: 1,
        id: randomUUID(),
        idempotencyKey,
        workspaceId,
      })
      .onConflictDoNothing()
      .returning({ id: coordinationPlans.id })
    // A concurrent create with the same key committed first: converge on its row.
    if (!plan) {
      const raced = await replay()
      if (raced) return raced
      throw new Error('Plan unavailable')
    }
    return insertRevision(
      transaction,
      { channelId, id: plan.id, workspaceId },
      1,
      actor.userId,
      jobIds
    )
  })
}

/**
 * Writes revision `expectedRevision + 1`. The writer must have seen the current revision: a plan
 * that moved on, in any way, is refused with a version conflict and is left as it was.
 */
export async function reviseCoordinationPlan(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  planId: string,
  actor: UserPrincipalRef,
  input: Readonly<{ expectedRevision: number; jobIds: readonly string[] }>
): Promise<CoordinationPlanRevisionView> {
  if (!isRevision(input.expectedRevision) || input.expectedRevision >= MAX_REVISION)
    throw new Error('Plan citations invalid')
  const jobIds = normalizePlanJobIds(input.jobIds)
  return database.transaction(async (transaction) => {
    await requirePlanWriter(transaction, workspaceId, channelId, actor)
    if (!UUID.test(planId)) throw new Error('Plan unavailable')
    const [plan] = await transaction
      .select()
      .from(coordinationPlans)
      .where(
        and(
          eq(coordinationPlans.id, planId),
          eq(coordinationPlans.workspaceId, workspaceId),
          eq(coordinationPlans.channelId, channelId)
        )
      )
      .limit(1)
      .for('update')
    if (!plan) throw new Error('Plan unavailable')
    if (plan.currentRevision !== input.expectedRevision) throw new Error('Plan version conflict')
    const carried = new Set(await readCitedJobIds(transaction, plan.id, plan.currentRevision))
    await requireReleasedCitations(
      transaction,
      workspaceId,
      channelId,
      actor,
      jobIds.filter((jobId) => !carried.has(jobId))
    )
    const revision = plan.currentRevision + 1
    const view = await insertRevision(transaction, plan, revision, actor.userId, jobIds)
    await transaction
      .update(coordinationPlans)
      .set({ currentRevision: revision, updatedAt: new Date() })
      .where(eq(coordinationPlans.id, plan.id))
    return view
  })
}

/**
 * The cited jobs of one revision, as `reader` may see them now. The reader must hold read access
 * to the channel; a missing plan, a missing revision and a plan of another channel are one
 * `Plan unavailable`.
 */
export async function readCoordinationPlanJobReferences(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  planId: string,
  revision: number,
  reader: UserPrincipalRef
): Promise<CoordinationPlanReferences> {
  return database.transaction(async (transaction) => {
    const channel = await requireChannelAccess(transaction, workspaceId, channelId, reader, 'read')
    if (channel.kind !== 'group') throw new Error('Channel unavailable')
    if (!UUID.test(planId) || !isRevision(revision)) throw new Error('Plan unavailable')
    const [plan] = await transaction
      .select({ currentRevision: coordinationPlans.currentRevision, id: coordinationPlans.id })
      .from(coordinationPlans)
      .where(
        and(
          eq(coordinationPlans.id, planId),
          eq(coordinationPlans.workspaceId, workspaceId),
          eq(coordinationPlans.channelId, channelId)
        )
      )
      .limit(1)
    if (!plan || revision > plan.currentRevision) throw new Error('Plan unavailable')
    const jobIds = await readCitedJobIds(transaction, plan.id, revision)
    // The plan is a pointer: every reference is resolved for this reader, in this channel, now.
    const references = await resolveJobReferences(transaction, {
      channelId,
      jobIds,
      reader,
      workspaceId,
    })
    return { planId: plan.id, references, revision }
  })
}
