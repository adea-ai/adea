import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { channels } from './conversations'
import { entityId, timestampColumns } from './conventions'
import { users } from './identity'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

/**
 * Coordination plans (M15.03, adea-ai/adea#1217).
 *
 * A plan belongs to one group channel and its workspace. It stores nothing but an ordered list of
 * job ids per revision: no titles, no summaries, no private context. What a reader may see of a
 * cited job is decided on every read by the job-outbound reference resolver, so the plan is a
 * pointer and never a copy.
 *
 * Revisions are append-only. `current_revision` is the optimistic-concurrency token; accepted
 * revisions and their citations cannot be updated or deleted (trigger in migration 0056).
 */
export const coordinationPlans = appSchema.table(
  'coordination_plans',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currentRevision: integer('current_revision').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createPayloadHash: text('create_payload_hash').notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('coordination_plans_idempotency_unique').on(
      table.workspaceId,
      table.channelId,
      table.idempotencyKey
    ),
    // The revision tables reference the plan together with its channel, so a revision can never
    // name a plan of another channel.
    unique('coordination_plans_scope_unique').on(table.id, table.workspaceId, table.channelId),
    index('coordination_plans_channel_idx').on(table.workspaceId, table.channelId),
    check(
      'coordination_plans_revision_valid',
      sql`${table.currentRevision} between 1 and 2147483647`
    ),
    check(
      'coordination_plans_idempotency_valid',
      sql`length(${table.idempotencyKey}) between 1 and 128`
    ),
  ]
)

export const coordinationPlanRevisions = appSchema.table(
  'coordination_plan_revisions',
  {
    planId: uuid('plan_id').notNull(),
    revision: integer('revision').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    /** Derived server-side from the authenticated principal, never from the request body. */
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.revision], name: 'coordination_plan_revisions_pk' }),
    foreignKey({
      columns: [table.planId, table.workspaceId, table.channelId],
      foreignColumns: [
        coordinationPlans.id,
        coordinationPlans.workspaceId,
        coordinationPlans.channelId,
      ],
      name: 'coordination_plan_revisions_plan_scope_fk',
    }).onDelete('restrict'),
    check('coordination_plan_revisions_revision_valid', sql`${table.revision} >= 1`),
  ]
)

/**
 * One cited job id per row. `job_id` is deliberately not a foreign key: a citation is not a
 * dependency on the job, must not constrain the job's own lifecycle, and must not let a citing
 * workspace observe the job's existence through referential errors.
 */
export const coordinationPlanCitations = appSchema.table(
  'coordination_plan_citations',
  {
    planId: uuid('plan_id').notNull(),
    revision: integer('revision').notNull(),
    position: smallint('position').notNull(),
    jobId: uuid('job_id').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.planId, table.revision, table.position],
      name: 'coordination_plan_citations_pk',
    }),
    foreignKey({
      columns: [table.planId, table.revision],
      foreignColumns: [coordinationPlanRevisions.planId, coordinationPlanRevisions.revision],
      name: 'coordination_plan_citations_revision_fk',
    }).onDelete('restrict'),
    unique('coordination_plan_citations_job_unique').on(table.planId, table.revision, table.jobId),
    check('coordination_plan_citations_position_valid', sql`${table.position} between 0 and 49`),
  ]
)

export type CoordinationPlan = typeof coordinationPlans.$inferSelect
