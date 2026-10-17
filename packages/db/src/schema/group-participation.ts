import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

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

/**
 * Durable provenance for ambiguous legacy group participants (#1222). The source participant row
 * is retained in place; this record captures its identity/digest and the exact derived admission or
 * grant rows withdrawn by the quarantine migration. Principal IDs are intentionally not foreign
 * keys so removing a user or Agent cannot erase the evidence needed to keep that audience denied.
 */
export const legacyAudienceQuarantine = appSchema.table(
  'legacy_audience_quarantine',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    principalKind: conversationPrincipalKind('principal_kind').notNull(),
    principalId: uuid('principal_id').notNull(),
    reason: text('reason').notNull(),
    sourceParticipantId: uuid('source_participant_id').notNull(),
    sourceWorkspaceId: uuid('source_workspace_id').notNull(),
    sourceRowDigest: text('source_row_digest').notNull(),
    sourceChannelCreatedAt: text('source_channel_created_at').notNull(),
    sourceJoinedAt: text('source_joined_at').notNull(),
    profile: text('profile').notNull(),
    observedAt: text('observed_at').notNull(),
    withdrawnAdmissions: integer('withdrawn_admissions'),
    withdrawnAudienceGrants: integer('withdrawn_audience_grants'),
    withdrawnEnlistmentGrants: integer('withdrawn_enlistment_grants'),
    withdrawnDigest: text('withdrawn_digest'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('legacy_audience_quarantine_principal_unique').on(
      table.workspaceId,
      table.channelId,
      table.principalKind,
      table.principalId
    ),
    unique('legacy_audience_quarantine_source_unique').on(table.sourceParticipantId),
    check(
      'legacy_audience_quarantine_reason_known',
      sql`${table.reason} in ('agent_not_active', 'channel_workspace_mismatch', 'group_channel_not_active', 'user_not_workspace_member', 'agent_workspace_mismatch')`
    ),
    check('legacy_audience_quarantine_profile_nonempty', sql`length(btrim(${table.profile})) > 0`),
    check(
      'legacy_audience_quarantine_source_digest_hex',
      sql`${table.sourceRowDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'legacy_audience_quarantine_withdrawal_digest_hex',
      sql`${table.withdrawnDigest} is null or ${table.withdrawnDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'legacy_audience_quarantine_withdrawal_complete',
      sql`(${table.withdrawnDigest} is null) = (${table.withdrawnAdmissions} is null)
        and (${table.withdrawnDigest} is null) = (${table.withdrawnAudienceGrants} is null)
        and (${table.withdrawnDigest} is null) = (${table.withdrawnEnlistmentGrants} is null)`
    ),
    check(
      'legacy_audience_quarantine_withdrawal_counts_nonnegative',
      sql`(${table.withdrawnAdmissions} is null or ${table.withdrawnAdmissions} >= 0)
        and (${table.withdrawnAudienceGrants} is null or ${table.withdrawnAudienceGrants} >= 0)
        and (${table.withdrawnEnlistmentGrants} is null or ${table.withdrawnEnlistmentGrants} >= 0)`
    ),
    index('legacy_audience_quarantine_channel_idx').on(table.workspaceId, table.channelId),
  ]
)
