import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import { agents } from './agents'
import { entityId, timestampColumns } from './conventions'
import { commandOutbox } from './events'
import { users } from './identity'
import { runtimeNodeKind, runtimeNodes } from './runtime-nodes'
import { appSchema } from './schema'
import { tasks } from './tasks'
import { workspaces } from './workspaces'

export const taskSubmissionState = appSchema.enum('task_submission_state', [
  'pending_delivery',
  'queued_for_node',
])

/** One initial logical intent per Task. Payload lives only in the transient outbox. */
export const taskSubmissions = appSchema.table(
  'task_submissions',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull(),
    commandId: uuid('command_id').notNull(),
    requestId: uuid('request_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    /** Original authority; legacy rows without recoverable audit provenance remain withheld. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    runtimeNodeId: uuid('runtime_node_id').notNull(),
    locationKind: runtimeNodeKind('location_kind').notNull(),
    state: taskSubmissionState('state').notNull(),
    taskVersion: integer('task_version').notNull(),
    profileId: text('profile_id').notNull(),
    profileVersion: text('profile_version').notNull(),
    profileRevision: integer('profile_revision').notNull(),
    payloadHash: text('payload_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('task_submissions_task_unique').on(table.taskId),
    unique('task_submissions_workspace_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKey
    ),
    unique('task_submissions_workspace_request_unique').on(table.workspaceId, table.requestId),
    unique('task_submissions_command_unique').on(table.commandId),
    foreignKey({
      columns: [table.workspaceId, table.taskId],
      foreignColumns: [tasks.workspaceId, tasks.id],
      name: 'task_submissions_task_scope_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
      name: 'task_submissions_agent_scope_fk',
    }),
    foreignKey({
      columns: [table.workspaceId, table.runtimeNodeId],
      foreignColumns: [runtimeNodes.workspaceId, runtimeNodes.id],
      name: 'task_submissions_node_scope_fk',
    }),
    foreignKey({
      columns: [table.workspaceId, table.commandId],
      foreignColumns: [commandOutbox.workspaceId, commandOutbox.id],
      name: 'task_submissions_command_scope_fk',
    }),
    index('task_submissions_node_pending_idx').on(
      table.workspaceId,
      table.runtimeNodeId,
      table.state,
      table.createdAt
    ),
    check(
      'task_submissions_version_valid',
      sql`${table.taskVersion} > 0 and ${table.profileRevision} >= 0`
    ),
    check('task_submissions_hash_valid', sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'task_submissions_idempotency_bounded',
      sql`char_length(${table.idempotencyKey}) between 1 and 128`
    ),
    check(
      'task_submissions_profile_valid',
      sql`${table.profileId} ~ '^prf_[0-9A-HJKMNP-TV-Z]{26}$' and ${table.profileVersion} ~ '^pfv_[0-9A-HJKMNP-TV-Z]{26}$'`
    ),
  ]
)
