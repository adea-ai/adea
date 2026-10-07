import { sql } from 'drizzle-orm'
import { text, timestamp, uuid } from 'drizzle-orm/pg-core'

export function entityId(name = 'id') {
  return uuid(name).defaultRandom().primaryKey()
}

export function timestampColumns() {
  return {
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  }
}

export function softDeleteColumns() {
  return {
    deletedAt: timestamp('deleted_at', { mode: 'date', withTimezone: true }),
  }
}

/**
 * A Control Plane scope identifier (ADR 0013): a prefixed ULID in the Control
 * Plane grammar `^(wsp|prj|rnr|tsk|agt)_[0-9A-HJKMNP-TV-Z]{26}$`. Adea mints it on
 * create; the database default (`app.control_plane_identifier`, migration
 * 0033) mints one for any other insert path and backfilled existing rows, so
 * a Worker that predates the column keeps inserting.
 */
export function controlPlaneIdentifierColumn(
  name: string,
  prefix: 'agt' | 'prj' | 'rnr' | 'tsk' | 'wsp'
) {
  return text(name)
    .default(sql.raw(`app.control_plane_identifier('${prefix}')`))
    .notNull()
}

export type JsonObject = Record<string, unknown>
