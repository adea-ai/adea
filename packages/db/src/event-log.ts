// Reads and maintenance for the durable workspace event log.
//
// The log is the authoritative replay source: delivery may be lost, duplicated,
// or delayed, and a client always recovers by reading events strictly after its
// cursor in `workspace_sequence` order. Nothing here consults a transport, and
// nothing here returns private content — payloads were validated on the way in.

import { and, asc, count, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm'

import type { AgentHqDatabase } from './connection'
import type { WorkspaceEventActorKind } from './event-contract'
import type { JsonObject } from './schema'
import { workspaceEventDispatches, workspaceEvents } from './schema'

/** One event as a client or replay consumer sees it. */
export type WorkspaceEventView = Readonly<{
  aggregateId: string | null
  aggregateType: string
  actor: Readonly<{ id: string; kind: WorkspaceEventActorKind }> | null
  correlationId: string | null
  eventId: string
  eventType: string
  occurredAt: Date
  payload: JsonObject
  schemaVersion: number
  workspaceSequence: number
}>

/** Bounded replay page size; callers page with the last sequence they saw. */
export const WORKSPACE_EVENT_PAGE_LIMIT = 200

function toView(row: typeof workspaceEvents.$inferSelect): WorkspaceEventView {
  return {
    aggregateId: row.aggregateId,
    aggregateType: row.aggregateType,
    actor: row.actorKind && row.actorId ? { id: row.actorId, kind: row.actorKind } : null,
    correlationId: row.correlationId,
    eventId: row.id,
    eventType: row.eventType,
    occurredAt: row.occurredAt,
    payload: row.payload,
    schemaVersion: row.schemaVersion,
    workspaceSequence: row.workspaceSequence,
  }
}

/**
 * Events strictly after a cursor, in per-workspace sequence order. This is the
 * only replay path: strictly-after semantics make duplicate delivery harmless,
 * and a cursor the caller already processed simply returns nothing new.
 */
export async function listWorkspaceEventsAfter(
  database: AgentHqDatabase,
  workspaceId: string,
  afterSequence: number,
  limit: number = WORKSPACE_EVENT_PAGE_LIMIT
): Promise<WorkspaceEventView[]> {
  const rows = await database
    .select()
    .from(workspaceEvents)
    .where(
      and(
        eq(workspaceEvents.workspaceId, workspaceId),
        gt(workspaceEvents.workspaceSequence, afterSequence)
      )
    )
    .orderBy(asc(workspaceEvents.workspaceSequence))
    .limit(Math.max(1, Math.min(limit, WORKSPACE_EVENT_PAGE_LIMIT)))

  return rows.map(toView)
}

/**
 * The retained window for a workspace: the earliest and latest sequences a
 * client can still replay. A cursor outside it cannot be proven continuous and
 * must be answered with `resync_required` rather than a silent gap.
 */
export async function workspaceEventWindow(
  database: AgentHqDatabase,
  workspaceId: string
): Promise<Readonly<{ earliest: number | null; latest: number }>> {
  const [row] = await database
    .select({
      earliest: sql<number | null>`min(${workspaceEvents.workspaceSequence})`,
      latest: sql<number | null>`max(${workspaceEvents.workspaceSequence})`,
    })
    .from(workspaceEvents)
    .where(eq(workspaceEvents.workspaceId, workspaceId))

  // Aggregates over bigint arrive as strings; sequences are far below the safe
  // integer range, and a string here would silently break cursor comparisons.
  return { earliest: sequenceOrNull(row?.earliest), latest: sequenceOrNull(row?.latest) ?? 0 }
}

function sequenceOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return Number(value)
}

/** How many events a workspace has logged; used by retention reporting. */
export async function countWorkspaceEvents(
  database: AgentHqDatabase,
  workspaceId: string
): Promise<number> {
  const [row] = await database
    .select({ total: count() })
    .from(workspaceEvents)
    .where(eq(workspaceEvents.workspaceId, workspaceId))
  return Number(row?.total ?? 0)
}

/**
 * Retention: drop events at or before a sequence, oldest first and bounded per
 * call. Deletion cascades to publication records, so a pruned event cannot be
 * reported as pending delivery afterwards.
 */
export async function pruneWorkspaceEventsBefore(
  database: AgentHqDatabase,
  workspaceId: string,
  beforeSequence: number,
  limit = WORKSPACE_EVENT_PAGE_LIMIT
): Promise<number> {
  const doomed = await database
    .select({ id: workspaceEvents.id })
    .from(workspaceEvents)
    .where(
      and(
        eq(workspaceEvents.workspaceId, workspaceId),
        lte(workspaceEvents.workspaceSequence, beforeSequence)
      )
    )
    .orderBy(asc(workspaceEvents.workspaceSequence))
    .limit(Math.max(1, limit))

  if (doomed.length === 0) return 0
  await database.delete(workspaceEvents).where(
    inArray(
      workspaceEvents.id,
      doomed.map((row) => row.id)
    )
  )
  return doomed.length
}

/**
 * Publication records that have not been handed to a live listener yet. The
 * wake-up path publishes only these identities; the event log, not this record,
 * is what a client replays from, so losing a notification loses no event.
 */
export async function pendingEventDispatches(
  database: AgentHqDatabase,
  workspaceId: string,
  limit = WORKSPACE_EVENT_PAGE_LIMIT
): Promise<ReadonlyArray<Readonly<{ eventId: string; workspaceSequence: number }>>> {
  const rows = await database
    .select({
      eventId: workspaceEventDispatches.eventId,
      workspaceSequence: workspaceEventDispatches.workspaceSequence,
    })
    .from(workspaceEventDispatches)
    .where(
      and(
        eq(workspaceEventDispatches.workspaceId, workspaceId),
        sql`${workspaceEventDispatches.notifiedAt} is null`
      )
    )
    .orderBy(asc(workspaceEventDispatches.workspaceSequence))
    .limit(limit)
  return rows
}

/**
 * Mark every publication record up to a sequence as notified. Delivery reads
 * the event log, so this is bookkeeping: it records what a live listener has
 * been handed and nothing more.
 */
export async function markEventDispatchesNotified(
  database: AgentHqDatabase,
  workspaceId: string,
  throughSequence: number
): Promise<number> {
  const updated = await database
    .update(workspaceEventDispatches)
    .set({
      attempts: sql`${workspaceEventDispatches.attempts} + 1`,
      notifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceEventDispatches.workspaceId, workspaceId),
        lte(workspaceEventDispatches.workspaceSequence, throughSequence),
        sql`${workspaceEventDispatches.notifiedAt} is null`
      )
    )
    .returning({ id: workspaceEventDispatches.id })
  return updated.length
}

/** The newest events for a workspace, newest first: diagnostics and tests. */
export async function latestWorkspaceEvents(
  database: AgentHqDatabase,
  workspaceId: string,
  limit = 20
): Promise<WorkspaceEventView[]> {
  const rows = await database
    .select()
    .from(workspaceEvents)
    .where(eq(workspaceEvents.workspaceId, workspaceId))
    .orderBy(desc(workspaceEvents.workspaceSequence))
    .limit(limit)
  return rows.map(toView)
}
