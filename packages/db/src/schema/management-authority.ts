import { sql } from 'drizzle-orm'
import { check, index, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

import { entityId, timestampColumns } from './conventions'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

/**
 * Durable, Adea-owned idempotency claim for one CP-issued lead management
 * decision (M14.03.1, adea-ai/adea#1215). The row is inserted before the
 * effect and marked `succeeded`/`failed` after it, so a replay of the same
 * decision across workers, restarts or eviction can never apply the mutation
 * twice; an interrupted claim is answered with a typed `recovery_required`
 * refusal instead of a duplicate effect. Only digests and identifiers are
 * stored — never raw input, prompts or credentials.
 */
export const managementAuthorityConsumptionState = appSchema.enum(
  'management_authority_consumption_state',
  ['claimed', 'succeeded', 'failed']
)

export const managementAuthorityConsumptions = appSchema.table(
  'management_authority_consumptions',
  {
    id: entityId(),
    decisionId: text('decision_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    authorityRef: text('authority_ref').notNull(),
    authorityRevision: integer('authority_revision').notNull(),
    operation: text('operation').notNull(),
    targetId: text('target_id'),
    actionDigest: text('action_digest').notNull(),
    inputDigest: text('input_digest').notNull(),
    targetDigest: text('target_digest').notNull(),
    state: managementAuthorityConsumptionState('state').default('claimed').notNull(),
    /** Whole-receipt digest only; never the response payload itself. */
    resultDigest: text('result_digest'),
    failureCode: text('failure_code'),
    claimedAt: timestamp('claimed_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    unique('management_authority_consumptions_decision_unique').on(table.decisionId),
    check(
      'management_authority_consumptions_decision_bounded',
      sql`length(btrim(${table.decisionId})) between 1 and 128`
    ),
    check(
      'management_authority_consumptions_authority_bounded',
      sql`length(btrim(${table.authorityRef})) between 1 and 128`
    ),
    check(
      'management_authority_consumptions_operation_bounded',
      sql`length(btrim(${table.operation})) between 1 and 128`
    ),
    check(
      'management_authority_consumptions_target_bounded',
      sql`${table.targetId} is null or length(${table.targetId}) between 1 and 128`
    ),
    check(
      'management_authority_consumptions_revision_positive',
      sql`${table.authorityRevision} > 0`
    ),
    check(
      'management_authority_consumptions_digests_valid',
      sql`${table.actionDigest} ~ '^sha256:[a-f0-9]{64}$'
        and ${table.inputDigest} ~ '^sha256:[a-f0-9]{64}$'
        and ${table.targetDigest} ~ '^sha256:[a-f0-9]{64}$'`
    ),
    check(
      'management_authority_consumptions_state_fields',
      sql`(${table.state} = 'claimed'
          and ${table.completedAt} is null
          and ${table.resultDigest} is null
          and ${table.failureCode} is null)
        or (${table.state} = 'succeeded'
          and ${table.completedAt} is not null
          and ${table.failureCode} is null)
        or (${table.state} = 'failed'
          and ${table.completedAt} is not null
          and ${table.resultDigest} is null)`
    ),
    index('management_authority_consumptions_workspace_idx').on(table.workspaceId, table.createdAt),
  ]
)
