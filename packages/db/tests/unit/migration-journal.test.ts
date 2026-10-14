import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number; breakpoints: boolean }>
}

/**
 * Journal monotonicity guard (#1177 rechaining follow-up).
 *
 * Drizzle's PostgreSQL migrator skips pending migrations older than the
 * latest applied created_at. A new entry whose `when` does not strictly
 * exceed every predecessor is therefore silently skipped on upgrade
 * (proven by migration-journal-order.test.ts against real Postgres).
 * This static check gates the invariant without a database: indices
 * contiguous from zero, timestamps strictly increasing, tags unique,
 * and every entry backed by its SQL file (and vice versa).
 */
describe('migration journal order', () => {
  test('indices are contiguous from zero', () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, position) => position)
    )
  })

  test('timestamps are strictly increasing', () => {
    const whens = journal.entries.map((entry) => entry.when)
    for (let position = 1; position < whens.length; position++)
      expect(
        whens[position],
        `entry ${journal.entries[position]!.idx} (${journal.entries[position]!.tag}) must be later than every predecessor`
      ).toBeGreaterThan(whens[position - 1]!)
  })

  test('tags are unique and backed by SQL files in both directions', () => {
    const tags = journal.entries.map((entry) => entry.tag)
    expect(new Set(tags).size).toBe(tags.length)
    journal.entries.forEach((entry) =>
      expect(entry.tag.startsWith(`${String(entry.idx).padStart(4, '0')}_`)).toBe(true)
    )
    const sqlFiles = readdirSync(drizzleDir).filter((file) => file.endsWith('.sql'))
    expect(sqlFiles.toSorted(), 'every migration SQL file needs a journal entry').toEqual(
      tags.map((tag) => `${tag}.sql`).toSorted()
    )
  })
})
