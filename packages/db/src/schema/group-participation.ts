import { sql } from 'drizzle-orm'
import { bigint, check, index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import { agents } from './agents'
import { channels, conversationPrincipalKind } from './conversations'
import { entityId, timestampColumns } from './conventions'
import { users } from './identity'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

/**
 * Durable group audience and participation grants (M15 #1178).
 *
 * These tables are the authoritative source the pure participation policy
 * (`group-participation-policy`) authenticates presented grants against. One
 * row carries a grant's complete identity: the owning workspace, the group
 * channel it was issued for, its grant id and revision, its exact subject
 * (human, workspace-qualified Agent, or sharing recipient) and its validity
 * window. Timestamps store the presented ISO strings verbatim because the
 * policy compares and fail-closes on them as strings; normalizing would
 * change fail-closed behavior.
 *
 * Revocation is a live read/turn gate, never a job kill: setting
 * `revoked_at` denies future reads and turns immediately and holds late
 * publication, while the row — and the independently owned job — survive.
 * A regrant after revocation inserts a new row with a bumped revision; the
 * old row stays revoked, so a stale revision can never regain access and a
 * job admitted under it stays held by its retained binding.
 */
export const groupAudienceGrants = appSchema.table(
  'group_audience_grants',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    grantId: text('grant_id').notNull(),
    revision: integer('revision').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issuedAt: text('issued_at').notNull(),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('group_audience_grants_channel_grant_unique').on(table.channelId, table.grantId),
    check('group_audience_grants_grant_id_nonempty', sql`length(btrim(${table.grantId})) > 0`),
    check('group_audience_grants_revision_positive', sql`${table.revision} > 0`),
    check('group_audience_grants_issued_nonempty', sql`length(btrim(${table.issuedAt})) > 0`),
    index('group_audience_grants_channel_idx').on(table.workspaceId, table.channelId),
  ]
)

export const groupEnlistmentGrants = appSchema.table(
  'group_enlistment_grants',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    grantId: text('grant_id').notNull(),
    revision: integer('revision').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    issuedAt: text('issued_at').notNull(),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('group_enlistment_grants_channel_grant_unique').on(table.channelId, table.grantId),
    check('group_enlistment_grants_grant_id_nonempty', sql`length(btrim(${table.grantId})) > 0`),
    check('group_enlistment_grants_revision_positive', sql`${table.revision} > 0`),
    check('group_enlistment_grants_issued_nonempty', sql`length(btrim(${table.issuedAt})) > 0`),
    index('group_enlistment_grants_channel_idx').on(table.workspaceId, table.channelId),
  ]
)

export const groupSharingGrants = appSchema.table(
  'group_sharing_grants',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    grantId: text('grant_id').notNull(),
    revision: integer('revision').notNull(),
    principalKind: conversationPrincipalKind('principal_kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    issuedAt: text('issued_at').notNull(),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('group_sharing_grants_channel_grant_unique').on(table.channelId, table.grantId),
    check('group_sharing_grants_grant_id_nonempty', sql`length(btrim(${table.grantId})) > 0`),
    check('group_sharing_grants_revision_positive', sql`${table.revision} > 0`),
    check('group_sharing_grants_issued_nonempty', sql`length(btrim(${table.issuedAt})) > 0`),
    check(
      'group_sharing_grants_scope_known',
      sql`${table.scope} in ('earlier_history', 'earlier_summary')`
    ),
    check(
      'group_sharing_grants_principal_consistent',
      sql`(${table.principalKind} = 'user' and ${table.userId} is not null and ${table.agentId} is null) or (${table.principalKind} = 'agent' and ${table.userId} is null and ${table.agentId} is not null)`
    ),
    index('group_sharing_grants_channel_idx').on(table.workspaceId, table.channelId),
  ]
)

/**
 * Canonical retained admissions: one row per group member recording where
 * they joined (`joined_sequence`, the channel message frontier at admission)
 * and the exact authorization that admitted them (group, grant id, revision).
 * Roster reads and history decisions load these rows — never caller-supplied
 * priors — so a forged or foreign join point authorizes nothing. `joined_at`
 * stores the admission instant verbatim for deterministic policy evaluation.
 */
export const groupAdmissions = appSchema.table(
  'group_admissions',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    principalKind: conversationPrincipalKind('principal_kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    joinedSequence: bigint('joined_sequence', { mode: 'number' }).notNull(),
    joinedAt: text('joined_at').notNull(),
    authGroupId: text('auth_group_id').notNull(),
    authGrantId: text('auth_grant_id').notNull(),
    authRevision: integer('auth_revision').notNull(),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('group_admissions_user_unique')
      .on(table.channelId, table.userId)
      .where(sql`${table.principalKind} = 'user' and ${table.userId} is not null`),
    uniqueIndex('group_admissions_agent_unique')
      .on(table.channelId, table.agentId)
      .where(sql`${table.principalKind} = 'agent' and ${table.agentId} is not null`),
    check(
      'group_admissions_principal_consistent',
      sql`(${table.principalKind} = 'user' and ${table.userId} is not null and ${table.agentId} is null) or (${table.principalKind} = 'agent' and ${table.userId} is null and ${table.agentId} is not null)`
    ),
    check('group_admissions_join_nonnegative', sql`${table.joinedSequence} >= 0`),
    check('group_admissions_joined_nonempty', sql`length(btrim(${table.joinedAt})) > 0`),
    check('group_admissions_auth_group_nonempty', sql`length(btrim(${table.authGroupId})) > 0`),
    check('group_admissions_auth_grant_nonempty', sql`length(btrim(${table.authGrantId})) > 0`),
    check('group_admissions_auth_revision_positive', sql`${table.authRevision} > 0`),
    index('group_admissions_channel_idx').on(table.workspaceId, table.channelId),
  ]
)
