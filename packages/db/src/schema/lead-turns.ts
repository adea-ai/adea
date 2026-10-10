import { sql } from 'drizzle-orm'
import {
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
import type { RequestedRoleModelSelections } from '../lead-model-selections'
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
    requestedModelSelections: jsonb(
      'requested_model_selections'
    ).$type<RequestedRoleModelSelections>(),
    /** Structured handoff target: exact direct session, never prose. Null for legacy admissions. */
    handoffTargetSessionId: text('handoff_target_session_id'),
    handoffTargetGeneration: integer('handoff_target_generation'),
    handoffTargetTaskId: uuid('handoff_target_task_id'),
    /**
     * Ordinal of this admission within one target context (session and generation): 1 for the
     * first, and one more for each successor admitted after the previous runtime completed or
     * failed. Null exactly when there is no target.
     */
    handoffTargetAttempt: integer('handoff_target_attempt'),
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
      'lead_turn_intents_handoff_target_valid',
      sql`(${table.handoffTargetSessionId} is null and ${table.handoffTargetGeneration} is null and ${table.handoffTargetTaskId} is null and ${table.handoffTargetAttempt} is null) or (${table.handoffTargetSessionId} is not null and length(btrim(${table.handoffTargetSessionId})) between 1 and 256 and ${table.handoffTargetGeneration} is not null and ${table.handoffTargetGeneration} >= 0 and ${table.handoffTargetTaskId} is not null and ${table.handoffTargetAttempt} is not null and ${table.handoffTargetAttempt} >= 1)`
    ),
    check(
      'lead_turn_intents_blocked_only',
      sql`${table.state} = 'blocked' and ${table.reasonCode} = 'ADMISSION_SERVICE_UNAVAILABLE'`
    ),
    check(
      'lead_turn_intents_requested_models_valid',
      sql`${table.requestedModelSelections} is null or (
        jsonb_typeof(${table.requestedModelSelections}) = 'object'
        and ${table.requestedModelSelections} <> '{}'::jsonb
        and (${table.requestedModelSelections} - 'lead' - 'child') = '{}'::jsonb
        and ${sql.join(
          ['lead', 'child'].map((role) => {
            const key = sql.raw("'" + role + "'")
            const choice = sql`${table.requestedModelSelections}->${key}`
            return sql`(not (${table.requestedModelSelections} ? ${key}) or (
            jsonb_typeof(${choice}) = 'object'
            and ${choice} ? 'selectionRef' and ${choice} ? 'selectionRevision'
            and ((${choice}) - 'selectionRef' - 'selectionRevision') = '{}'::jsonb
            and jsonb_typeof(${choice}->'selectionRef') = 'string'
            and ${choice}->>'selectionRef' ~ '^msel_[a-f0-9]{32}$'
            and jsonb_typeof(${choice}->'selectionRevision') = 'number'
            and ${choice}->>'selectionRevision' ~ '^[0-9]+$'
            and (${choice}->>'selectionRevision')::numeric between 1 and 9007199254740991
          ))`
          }),
          sql` and `
        )}
      )`
    ),
    index('lead_turn_intents_workspace_channel_idx').on(table.workspaceId, table.channelId),
    // Exactly one admission per target context and attempt: concurrent same-target admissions
    // serialize on the channel lock, and the loser recovers the winner. A successor takes the
    // next attempt, so a completed or failed predecessor stays retained and unchanged.
    uniqueIndex('lead_turn_intents_target_unique')
      .on(
        table.workspaceId,
        table.channelId,
        table.handoffTargetSessionId,
        table.handoffTargetGeneration,
        table.handoffTargetAttempt
      )
      .where(sql`${table.handoffTargetSessionId} is not null`),
  ]
)
