// Applies a historical prefix of the repository's migration chain to one
// disposable database.
//
// The prefix is applied the way it was applied when it was current: the same
// statements, in the same order, with the same ledger hash and the same ledger
// timestamp the migration runner of that day wrote. The module never decides
// whether the result is a valid historical prefix. The database package's own
// migration-history preflight decides that, and its own migrator moves a
// database of that age forward. This module only reproduces the state such a
// database carried, so a proof can compare a restored target against one.
//
// It runs as its own child process, under a deadline, because it opens its own
// pool: a pool the test does not own is a pool the test's own client bounds
// cannot reach.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Pool } from 'pg'

type Journal = {
  entries: ReadonlyArray<{ breakpoints: boolean; tag: string; when: number }>
}

const folder = process.env.AUTH_PREFIX_MIGRATION_FOLDER
const databaseUrl = process.env.AUTH_MIGRATION_DATABASE_URL
const schema = process.env.AUTH_MIGRATION_SCHEMA ?? 'app'
const requested = Number(process.env.AUTH_PREFIX_MIGRATION_COUNT)

/** The statements one migration file carries, in order. */
function statementsOf(query: string): string[] {
  return query
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

async function applyPrefix(): Promise<void> {
  if (!folder || !databaseUrl) {
    throw new Error('the prefix runner needs its migration folder and its database URL')
  }
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error('the prefix count must be a positive count')
  }
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as Journal
  const entries = journal.entries.slice(0, requested)
  if (entries.length !== requested) {
    throw new Error(`the migration chain holds ${journal.entries.length} migrations`)
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    max: 1,
    query_timeout: 5_000,
  })
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "${schema}"."__drizzle_migrations" ("id" serial PRIMARY KEY, "hash" text NOT NULL, "created_at" bigint)`
    )
    for (const entry of entries) {
      const query = readFileSync(join(folder, `${entry.tag}.sql`), 'utf8')
      const hash = createHash('sha256').update(query).digest('hex')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (const statement of statementsOf(query)) {
          await client.query(statement)
        }
        await client.query(
          `INSERT INTO "${schema}"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
          [hash, entry.when]
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
    const applied = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${schema}"."__drizzle_migrations"`
    )
    console.log(
      JSON.stringify({
        applied: applied.rows[0]?.n ?? -1,
        migrations: entries.map((entry) => entry.tag),
      })
    )
  } finally {
    await pool.end().catch(() => undefined)
  }
}

await applyPrefix()
