import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

import { entityId, type JsonObject, timestampColumns } from './conventions'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

export const workspaceEventAggregateType = appSchema.enum('workspace_event_aggregate_type', [
  'workspace',
  'room',
  'channel',
  'message',
  'task',
  'agent',
  'artifact',
  'content_ref',
  'runtime_node',
])

export const workspaceEventActorKind = appSchema.enum('workspace_event_actor_kind', [
  'user',
  'agent',
  'system',
])

export const workspaceEvents = appSchema.table(
  'workspace_events',
  {
    id: entityId(),
    /** Global append order, used for cross-workspace dispatch ordering. */
    sequence: bigint('sequence', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /**
     * Monotonic sequence within one workspace, allocated transactionally with
     * the domain mutation. This is the cursor clients advance and the order
     * replay must preserve; `sequence` is only the physical append order.
     */
    workspaceSequence: bigint('workspace_sequence', { mode: 'number' }).notNull(),
    eventType: text('event_type').notNull(),
    /** Payload shape version declared by the event contract. */
    schemaVersion: integer('schema_version').notNull(),
    aggregateType: workspaceEventAggregateType('aggregate_type').notNull(),
    aggregateId: text('aggregate_id'),
    actorKind: workspaceEventActorKind('actor_kind'),
    actorId: uuid('actor_id'),
    correlationId: uuid('correlation_id'),
    /** Redacted, cloud-safe payload. Private bodies and key material never land here. */
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    occurredAt: timestamp('occurred_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('workspace_events_sequence_uidx').on(table.sequence),
    uniqueIndex('workspace_events_workspace_sequence_uidx').on(
      table.workspaceId,
      table.workspaceSequence
    ),
    index('workspace_events_replay_idx').on(table.workspaceId, table.workspaceSequence),
    index('workspace_events_type_idx').on(table.workspaceId, table.eventType),
    check('workspace_events_workspace_sequence_positive', sql`${table.workspaceSequence} > 0`),
    check('workspace_events_schema_version_positive', sql`${table.schemaVersion} > 0`),
  ]
)

/**
 * Per-workspace sequence allocator. A single row per workspace is updated
 * inside the domain transaction, so concurrent writers serialize on the row and
 * a rolled-back mutation also rolls back its sequence — a rollback can never
 * leave a gap that a client would read as a missing committed event.
 */
export const workspaceEventSequences = appSchema.table(
  'workspace_event_sequences',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    lastSequence: bigint('last_sequence', { mode: 'number' }).default(0).notNull(),
    ...timestampColumns(),
  },
  (table) => [check('workspace_event_sequences_nonnegative', sql`${table.lastSequence} >= 0`)]
)

/**
 * Publication record for the durable log: one row per committed event, written
 * in the same transaction. Delivery reads the event log (authoritative) and
 * marks these rows notified, so a lost wake-up never loses an event and a
 * notification never carries more than an event identity.
 */
export const workspaceEventDispatches = appSchema.table(
  'workspace_event_dispatches',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => workspaceEvents.id, { onDelete: 'cascade' }),
    workspaceSequence: bigint('workspace_sequence', { mode: 'number' }).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    notifiedAt: timestamp('notified_at', { mode: 'date', withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('workspace_event_dispatches_event_uidx').on(table.eventId),
    index('workspace_event_dispatches_pending_idx').on(table.workspaceId, table.workspaceSequence),
    check('workspace_event_dispatches_attempts_nonnegative', sql`${table.attempts} >= 0`),
  ]
)

export const outboxStatus = appSchema.enum('outbox_status', [
  'pending',
  'processing',
  'delivered',
  'failed',
])

export const commandOutbox = appSchema.table(
  'command_outbox',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    commandType: text('command_type').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    status: outboxStatus('status').default('pending').notNull(),
    attempts: bigint('attempts', { mode: 'number' }).default(0).notNull(),
    availableAt: timestamp('available_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    deliveredAt: timestamp('delivered_at', { mode: 'date', withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('command_outbox_idempotency_uidx').on(table.idempotencyKey),
    check('command_outbox_attempts_nonnegative', sql`${table.attempts} >= 0`),
    index('command_outbox_delivery_idx').on(table.status, table.availableAt),
    index('command_outbox_workspace_idx').on(table.workspaceId, table.createdAt),
  ]
)

export const eventInbox = appSchema.table(
  'event_inbox',
  {
    id: entityId(),
    source: text('source').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    receivedAt: timestamp('received_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp('processed_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    unique('event_inbox_source_event_unique').on(table.source, table.sourceEventId),
    index('event_inbox_unprocessed_idx').on(table.processedAt, table.receivedAt),
  ]
)
