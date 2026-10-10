import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { channels, messages } from './conversations'
import { entityId, timestampColumns } from './conventions'
import { users } from './identity'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

/**
 * Immutable, server-owned admission intent. Contains references only, never model auth or bodies.
 * `rollback_fenced_at` is the only post-admission field: set once by the rollback fence (M18.01.3,
 * #1220), never cleared, and nullable so pre-fence readers and writers remain compatible.
 */
export const leadTurnIntents = appSchema.table(
  'lead_turn_intents',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    controlPlaneAgentId: text('control_plane_agent_id').notNull(),
    profileId: text('profile_id').notNull(),
    profileVersion: text('profile_version').notNull(),
    profileRevision: integer('profile_revision').notNull(),
    channelVersion: integer('channel_version').notNull(),
    channelVisibility: text('channel_visibility').notNull(),
    audience: jsonb('audience').$type<readonly string[]>().notNull(),
    dispatchKey: text('dispatch_key').notNull(),
    state: text('state').default('blocked').notNull(),
    reasonCode: text('reason_code').default('ADMISSION_SERVICE_UNAVAILABLE').notNull(),
    rollbackFencedAt: timestamp('rollback_fenced_at', { mode: 'date', withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    unique('lead_turn_intents_message_unique').on(table.messageId),
    unique('lead_turn_intents_dispatch_key_unique').on(table.dispatchKey),
    check(
      'lead_turn_intents_dispatch_key_valid',
      sql`${table.dispatchKey} = 'lead-turn:' || ${table.id}::text`
    ),
    check('lead_turn_intents_profile_revision_valid', sql`${table.profileRevision} >= 0`),
    check('lead_turn_intents_channel_version_valid', sql`${table.channelVersion} > 0`),
    check(
      'lead_turn_intents_visibility_valid',
      sql`${table.channelVisibility} in ('workspace', 'participants')`
    ),
    check('lead_turn_intents_audience_valid', sql`jsonb_typeof(${table.audience}) = 'array'`),
    check(
      'lead_turn_intents_blocked_only',
      sql`${table.state} = 'blocked' and ${table.reasonCode} = 'ADMISSION_SERVICE_UNAVAILABLE'`
    ),
    index('lead_turn_intents_workspace_channel_idx').on(table.workspaceId, table.channelId),
  ]
)
