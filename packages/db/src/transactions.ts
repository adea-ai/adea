import { sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  assertCloudSafeEventPayload,
  type WorkspaceEventActorKind,
  type WorkspaceEventType,
  resolveWorkspaceEventContract,
} from './event-contract'
import type { JsonObject } from './schema'
import { workspaceEventDispatches, workspaceEventSequences, workspaceEvents } from './schema'

export function inTransaction<T>(
  database: AgentHqDatabase,
  operation: (transaction: AgentHqTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(operation)
}

/** What a domain mutation hands to the durable event log. */
export type WorkspaceEventInput = Readonly<{
  workspaceId: string
  eventType: WorkspaceEventType
  /** Redacted, cloud-safe payload; validated against the event contract. */
  payload: JsonObject
  /** Who caused the change, when the payload names a principal. */
  actor?: Readonly<{ kind: WorkspaceEventActorKind; id: string }> | null
  /** Ties an event to a request, command, or upstream message. */
  correlationId?: string | null
  occurredAt?: Date
}>

/** The committed event as the log stores it. */
export type WorkspaceEventRecord = Readonly<{
  aggregateId: string | null
  aggregateType: string
  correlationId: string | null
  eventId: string
  eventType: WorkspaceEventType
  occurredAt: Date
  schemaVersion: number
  workspaceId: string
  workspaceSequence: number
}>

/**
 * The acting principal, when the payload names one. Domain events record the
 * acting user as `actorUserId` (or `ownerUserId` for provisioning); the log
 * keeps that as structured actor metadata so consumers do not parse payloads.
 */
function derivedActor(payload: JsonObject): Readonly<{ kind: 'user'; id: string }> | null {
  const candidate = payload.actorUserId ?? payload.ownerUserId
  return typeof candidate === 'string' ? { kind: 'user', id: candidate } : null
}

/**
 * Allocate the workspace's next sequence inside the caller's transaction. The
 * upsert takes a row lock, so concurrent writers to one workspace serialize and
 * receive distinct ordered sequences; a rollback releases the increment together
 * with the rest of the transaction, so committed events have no gaps.
 */
async function allocateWorkspaceSequence(
  transaction: AgentHqTransaction,
  workspaceId: string
): Promise<number> {
  const [allocated] = await transaction
    .insert(workspaceEventSequences)
    .values({ workspaceId, lastSequence: 1 })
    .onConflictDoUpdate({
      target: workspaceEventSequences.workspaceId,
      set: { lastSequence: sql`${workspaceEventSequences.lastSequence} + 1` },
    })
    .returning({ lastSequence: workspaceEventSequences.lastSequence })

  if (!allocated) throw new Error('Workspace event sequence allocation failed')
  return allocated.lastSequence
}

/**
 * Append one durable workspace event as part of a domain mutation.
 *
 * The event, its per-workspace sequence, and its dispatch record commit
 * atomically with the mutation: either the change and its event both exist, or
 * neither does. The payload is validated against the event contract, so a
 * private body, a key envelope, or a transient delta cannot enter the log.
 */
export async function appendWorkspaceEvent(
  transaction: AgentHqTransaction,
  event: WorkspaceEventInput
): Promise<WorkspaceEventRecord> {
  const contract = resolveWorkspaceEventContract(event.eventType)
  assertCloudSafeEventPayload(event.eventType, event.payload)

  const workspaceSequence = await allocateWorkspaceSequence(transaction, event.workspaceId)
  const aggregateId = contract.aggregateIdKey
    ? String(event.payload[contract.aggregateIdKey])
    : null
  const actor = event.actor ?? derivedActor(event.payload)

  const [inserted] = await transaction
    .insert(workspaceEvents)
    .values({
      actorId: actor?.id ?? null,
      actorKind: actor?.kind ?? null,
      aggregateId,
      aggregateType: contract.aggregateType,
      ...(event.correlationId ? { correlationId: event.correlationId } : {}),
      eventType: event.eventType,
      ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
      payload: event.payload,
      schemaVersion: contract.schemaVersion,
      workspaceId: event.workspaceId,
      workspaceSequence,
    })
    .returning({ id: workspaceEvents.id, occurredAt: workspaceEvents.occurredAt })

  if (!inserted) throw new Error(`Workspace event ${event.eventType} was not appended`)

  await transaction.insert(workspaceEventDispatches).values({
    eventId: inserted.id,
    workspaceId: event.workspaceId,
    workspaceSequence,
  })

  return {
    aggregateId,
    aggregateType: contract.aggregateType,
    correlationId: event.correlationId ?? null,
    eventId: inserted.id,
    eventType: event.eventType,
    occurredAt: inserted.occurredAt,
    schemaVersion: contract.schemaVersion,
    workspaceId: event.workspaceId,
    workspaceSequence,
  }
}
