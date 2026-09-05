import {
  bigint,
  check,
  index,
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

export const workspaceEvents = appSchema.table(
  'workspace_events',
  {
    id: entityId(),
    sequence: bigint('sequence', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    occurredAt: timestamp('occurred_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('workspace_events_sequence_uidx').on(table.sequence),
    index('workspace_events_replay_idx').on(table.workspaceId, table.sequence),
    index('workspace_events_type_idx').on(table.workspaceId, table.eventType),
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
