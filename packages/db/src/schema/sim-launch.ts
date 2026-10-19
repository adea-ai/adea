import { sql } from 'drizzle-orm'
import { check, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

import { entityId, timestampColumns } from './conventions'
import { appSchema } from './schema'

/**
 * Single-use launch codes for a hosted Agent Sim frame. Only a digest of the code is stored. A code is
 * spent by its first presentation (`consumed_at`), whether or not that presentation matched its binding.
 */
export const simLaunchCodes = appSchema.table(
  'sim_launch_codes',
  {
    id: entityId(),
    codeDigest: text('code_digest').notNull(),
    workspaceId: text('workspace_id').notNull(),
    surface: text('surface').notNull(),
    bridgeId: text('bridge_id').notNull(),
    origin: text('origin').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { mode: 'date', withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    unique('sim_launch_codes_code_digest_unique').on(table.codeDigest),
    check('sim_launch_codes_digest_nonempty', sql`length(${table.codeDigest}) > 0`),
    check(
      'sim_launch_codes_surface_closed',
      sql`${table.surface} in ('hq', 'room-designer', 'character-designer')`
    ),
    check('sim_launch_codes_workspace_nonempty', sql`length(${table.workspaceId}) > 0`),
    index('sim_launch_codes_expiry_idx').on(table.expiresAt),
  ]
)

/**
 * Sim sessions minted by a redemption. Only a digest of the session value is stored, and every row is
 * bound to the workspace and surface of the code that created it. Each code creates at most one session.
 */
export const simSessions = appSchema.table(
  'sim_sessions',
  {
    id: entityId(),
    sessionDigest: text('session_digest').notNull(),
    launchCodeId: uuid('launch_code_id')
      .notNull()
      .references(() => simLaunchCodes.id),
    workspaceId: text('workspace_id').notNull(),
    surface: text('surface').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    unique('sim_sessions_session_digest_unique').on(table.sessionDigest),
    unique('sim_sessions_launch_code_unique').on(table.launchCodeId),
    check('sim_sessions_digest_nonempty', sql`length(${table.sessionDigest}) > 0`),
    check(
      'sim_sessions_surface_closed',
      sql`${table.surface} in ('hq', 'room-designer', 'character-designer')`
    ),
    check('sim_sessions_workspace_nonempty', sql`length(${table.workspaceId}) > 0`),
    index('sim_sessions_workspace_active_idx').on(table.workspaceId, table.expiresAt),
  ]
)
