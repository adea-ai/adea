import { sql } from 'drizzle-orm'
import { bigint, check, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { timestampColumns } from './conventions'
import { messages } from './conversations'
import { leadTurnIntents } from './lead-turns'
import { appSchema } from './schema'

/** Durable dispatch binding and observations only. The canonical runtime owns sessions. */
export const leadTurnRuntime = appSchema.table(
  'lead_turn_runtime',
  {
    intentId: uuid('intent_id')
      .primaryKey()
      .references(() => leadTurnIntents.id, { onDelete: 'restrict' }),
    dispatchId: text('dispatch_id'),
    executionId: text('execution_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    selectionRef: text('selection_ref').notNull(),
    selectionRevision: bigint('selection_revision', { mode: 'number' }).notNull(),
    preparationRef: text('preparation_ref').notNull(),
    preparationExpiresAt: timestamp('preparation_expires_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    runtimeSessionId: text('runtime_session_id'),
    state: text('state').default('prepared').notNull(),
    observedAt: timestamp('observed_at', { mode: 'date', withTimezone: true }),
    cancelRequestedAt: timestamp('cancel_requested_at', { mode: 'date', withTimezone: true }),
    publishedMessageId: uuid('published_message_id').references(() => messages.id, {
      onDelete: 'restrict',
    }),
    publicationDigest: text('publication_digest'),
    ...timestampColumns(),
  },
  (table) => [
    unique('lead_turn_runtime_dispatch_unique').on(table.dispatchId),
    unique('lead_turn_runtime_attempt_unique').on(table.attemptId),
    check(
      'lead_turn_runtime_execution_valid',
      sql`${table.executionId} ~ '^exe_[0-9A-HJKMNP-TV-Z]{26}$'`
    ),
    check(
      'lead_turn_runtime_attempt_valid',
      sql`${table.attemptId} ~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'`
    ),
    check(
      'lead_turn_runtime_selection_valid',
      sql`${table.selectionRef} ~ '^msel_[a-f0-9]{32}$' and ${table.selectionRevision} between 1 and 9007199254740991`
    ),
    check(
      'lead_turn_runtime_preparation_valid',
      sql`${table.preparationRef} ~ '^prep_[a-f0-9]{32}$'`
    ),
    check(
      'lead_turn_runtime_binding_valid',
      sql`(${table.dispatchId} is null and ${table.runtimeSessionId} is null) or (${table.dispatchId} is not null and ${table.runtimeSessionId} is not null and ${table.dispatchId} ~ '^dispatch_[a-f0-9]{32}$' and ${table.runtimeSessionId} ~ '^ses_[0-9A-HJKMNP-TV-Z]{26}$')`
    ),
    check(
      'lead_turn_runtime_state_valid',
      sql`${table.state} in ('prepared','dispatch_pending','starting','running','awaiting_input','cancelling','completed','failed','cancelled','timed_out','unknown')`
    ),
    check(
      'lead_turn_runtime_observation_valid',
      sql`${table.state} in ('prepared','dispatch_pending') or (${table.dispatchId} is not null and ${table.observedAt} is not null)`
    ),
    check(
      'lead_turn_runtime_publication_valid',
      sql`(${table.publishedMessageId} is null and ${table.publicationDigest} is null) or (${table.publishedMessageId} is not null and ${table.publicationDigest} is not null and ${table.publicationDigest} ~ '^[a-f0-9]{64}$' and ${table.state} = 'completed')`
    ),
  ]
)
