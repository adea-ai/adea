import { sql } from 'drizzle-orm'
import { check, index, integer, text, unique, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { channels, messages } from './conversations'
import { entityId, timestampColumns } from './conventions'
import { leadTurnIntents } from './lead-turns'
import { users } from './identity'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

/**
 * Durable addressed-Agent turn claims (M15.02, adea-ai/adea#1179).
 *
 * One row per (triggering message, addressed Agent, dispatch revision):
 * the claim is persisted before any dispatch, so duplicate submissions,
 * restarts and reconnects converge on the same row and at most one
 * response is ever recorded per triple. Agent messages never create
 * claims implicitly — addressing is always an explicit human act, which
 * is what rules out automatic broadcast loops at the storage layer.
 */
export const addressedAgentTurns = appSchema.table(
  'addressed_agent_turns',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    /** Causal root: the human message that triggered this turn. */
    triggerMessageId: uuid('trigger_message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    /**
     * Recursion chain: null for root turns addressed directly by a human.
     * Plain uuid (no self-FK: TypeScript cannot infer the circular table
     * type); trigger agreement is enforced at claim time instead.
     */
    parentTurnId: uuid('parent_turn_id'),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    /**
     * Original human attribution: the principal that addressed this turn.
     * Cancellation authority derives from it (addresser or manager).
     */
    addresserUserId: uuid('addresser_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Workspace-qualified addressed label (`<sourceWorkspaceId>:<agentId>`)
     * shown to participants. The source workspace is the Agent's verified
     * home — never the conversation host. The `workspace_id` column keeps
     * the HOST workspace for conversation ownership; the two are equal
     * only for home Agents.
     */
    addressedLabel: text('addressed_label').notNull(),
    /** Deterministic causal ID: `turn:<triggerMessageId>:<agentId>:<revision>`. */
    causalId: text('causal_id').notNull(),
    dispatchRevision: integer('dispatch_revision').notNull(),
    /** 0 for root turns; parent depth + 1 for recursive follow-ups. */
    depth: integer('depth').notNull(),
    /** Budget recorded before dispatch: bounds on this turn tree. */
    maxDepth: integer('max_depth').notNull(),
    maxTurns: integer('max_turns').notNull(),
    state: text('state').default('claimed').notNull(),
    responseMessageId: uuid('response_message_id').references(() => messages.id, {
      onDelete: 'restrict',
    }),
    /**
     * Intent minted for this claim by dispatch (null until dispatched).
     * Binds cancellation to the exact retained intent — never a sibling
     * revision's. Crash recovery (minted but unbound) converges by
     * redispatch replay, which rebinds the same intent idempotently.
     */
    intentId: uuid('intent_id').references(() => leadTurnIntents.id, {
      onDelete: 'restrict',
    }),
    ...timestampColumns(),
  },
  (table) => [
    unique('addressed_agent_turns_claim_unique').on(
      table.triggerMessageId,
      table.agentId,
      table.dispatchRevision
    ),
    unique('addressed_agent_turns_causal_unique').on(table.causalId),
    index('addressed_agent_turns_channel_idx').on(table.workspaceId, table.channelId),
    check(
      'addressed_agent_turns_revision_valid',
      sql`${table.dispatchRevision} between 1 and 9007199254740991`
    ),
    check(
      'addressed_agent_turns_depth_valid',
      sql`${table.depth} >= 0 and ${table.maxDepth} >= 0 and ${table.maxTurns} >= 1`
    ),
    check('addressed_agent_turns_label_valid', sql`length(btrim(${table.addressedLabel})) > 0`),
    check(
      'addressed_agent_turns_state_valid',
      sql`${table.state} in ('claimed','dispatching','responded','superseded','cancelled')`
    ),
    check(
      'addressed_agent_turns_response_valid',
      sql`(${table.state} = 'responded' and ${table.responseMessageId} is not null) or (${table.state} != 'responded' and ${table.responseMessageId} is null)`
    ),
  ]
)

export type AddressedAgentTurn = typeof addressedAgentTurns.$inferSelect
