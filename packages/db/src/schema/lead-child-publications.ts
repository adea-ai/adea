import { sql } from 'drizzle-orm'
import { check, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { messages } from './conversations'
import { leadTurnIntents } from './lead-turns'
import { appSchema } from './schema'

/** Adea delivery receipt. A CP terminal publication has a separate identity and is never this row. */
export const leadChildPublications = appSchema.table(
  'lead_child_publications',
  {
    intentId: uuid('intent_id')
      .notNull()
      .references(() => leadTurnIntents.id, { onDelete: 'restrict' }),
    delegationId: text('delegation_id').notNull(),
    childExecutionId: text('child_execution_id').notNull(),
    childAttemptId: text('child_attempt_id').notNull(),
    outcomeDigest: text('outcome_digest').notNull(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    publishedAt: timestamp('published_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.intentId, table.delegationId] }),
    check(
      'lead_child_publications_delegation_valid',
      sql`${table.delegationId} ~ '^dlg_[0-9A-HJKMNP-TV-Z]{26}$'`
    ),
    check(
      'lead_child_publications_execution_valid',
      sql`${table.childExecutionId} ~ '^exe_[0-9A-HJKMNP-TV-Z]{26}$'`
    ),
    check(
      'lead_child_publications_attempt_valid',
      sql`${table.childAttemptId} ~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'`
    ),
    check('lead_child_publications_digest_valid', sql`${table.outcomeDigest} ~ '^[a-f0-9]{64}$'`),
  ]
)
