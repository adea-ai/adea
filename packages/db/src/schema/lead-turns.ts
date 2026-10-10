import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import type { RequestedRoleModelSelections } from '../lead-model-selections'
import { agents } from './agents'
import { channels, messages } from './conversations'
import { entityId, timestampColumns } from './conventions'
import { users } from './identity'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

/**
 * Immutable, server-owned admission intent. Contains references only, never model auth or bodies.
 * The `rollback_fence*` columns are the only post-admission fields. They are set together, once,
 * by the rollback fence (M18.01.3, #1220) and never cleared. Each is nullable so pre-fence readers
 * and writers remain compatible, and a CHECK keeps the attribution all-or-nothing (REQ 154).
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
    dispatchKey: text('dispatch_key').notNull(),
    state: text('state').default('blocked').notNull(),
    reasonCode: text('reason_code').default('ADMISSION_SERVICE_UNAVAILABLE').notNull(),
    rollbackFencedAt: timestamp('rollback_fenced_at', { mode: 'date', withTimezone: true }),
    rollbackFenceActorKind: text('rollback_fence_actor_kind'),
    rollbackFenceActorRef: text('rollback_fence_actor_ref'),
    rollbackFenceReason: text('rollback_fence_reason'),
    rollbackFenceAuthority: jsonb('rollback_fence_authority').$type<
      Readonly<Record<string, unknown>>
    >(),
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
    check(
      'lead_turn_intents_rollback_fence_complete',
      sql`(${table.rollbackFencedAt} is null and ${table.rollbackFenceActorKind} is null and ${table.rollbackFenceActorRef} is null and ${table.rollbackFenceReason} is null and ${table.rollbackFenceAuthority} is null) or (${table.rollbackFencedAt} is not null and ${table.rollbackFenceActorKind} is not null and ${table.rollbackFenceActorRef} is not null and ${table.rollbackFenceReason} is not null and ${table.rollbackFenceAuthority} is not null)`
    ),
    check(
      'lead_turn_intents_rollback_fence_actor_valid',
      sql`${table.rollbackFenceActorKind} is null or (${table.rollbackFenceActorKind} = 'user' and ${table.rollbackFenceActorRef} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') or (${table.rollbackFenceActorKind} = 'operator' and ${table.rollbackFenceActorRef} ~ '^[a-z0-9][a-z0-9._:-]{0,127}$')`
    ),
    check(
      'lead_turn_intents_rollback_fence_reason_valid',
      sql`${table.rollbackFenceReason} is null or ${table.rollbackFenceReason} in ('operator_intervention', 'rollback_cohort')`
    ),
    check(
      'lead_turn_intents_rollback_fence_authority_valid',
      sql`${table.rollbackFenceAuthority} is null or (jsonb_typeof(${table.rollbackFenceAuthority}) = 'object' and (${table.rollbackFenceAuthority}->>'schemaVersion') is not distinct from '1')`
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
  ]
)
