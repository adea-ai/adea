import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { createDatabase, type DatabaseConnection } from '../../src/connection'

const repoDrizzle = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
const connectionUrl = process.env.DATABASE_URL
// Live replay needs a scratch database, which needs CREATEDB — deliberately
// absent from the provisioned application roles (see scripts/test-integration.mjs).
// The integration runner provisions a throwaway superuser container per run and
// exports its admin URL here; without it this proof skips cleanly, exactly like
// the migration-snapshot capture proofs. The timestamp-order invariant itself is
// asserted statically (no database) in tests/unit/migration-journal.test.ts.
const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL

/**
 * Journal-timestamp upgrade guard (#1177 rechaining follow-up).
 *
 * Drizzle's PostgreSQL migrator skips pending migrations older than the
 * latest applied created_at. A journal entry whose `when` predates an
 * already-applied predecessor is therefore silently skipped on upgrade:
 * an existing database sitting at 0050 would never apply 0051, keeping
 * the old schema while the journal claims the chain complete. This test
 * replays exactly that upgrade — migrate through 0050, CLOSE/REOPEN the
 * connection (a separate process lifetime, like a deployed database),
 * then apply the complete chain — and proves the new migration lands
 * exactly once with its columns, check, and index.
 */
describe.skipIf(!connectionUrl)('migration journal timestamp order', () => {
  let first: DatabaseConnection | undefined
  let second: DatabaseConnection | undefined
  let admin: postgres.Sql | undefined
  let staged = ''
  let databaseUrl = ''
  afterAll(async () => {
    await first?.close().catch(() => undefined)
    await second?.close().catch(() => undefined)
    if (staged) rmSync(staged, { force: true, recursive: true })
    // Hermetic database: created for this test, dropped afterwards, so
    // file order and parallel suites can never leak state into it.
    if (admin && databaseUrl) {
      const name = new URL(databaseUrl).pathname.slice(1)
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('unsafe generated database name')
      await admin
        .unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`
        )
        .catch(() => undefined)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined)
      await admin.end({ timeout: 5 }).catch(() => undefined)
    }
  })

  test.skipIf(!provisioningUrl)(
    'an existing database at 0050 still applies 0051 exactly once',
    async () => {
      // A private database on the throwaway provisioning instance only:
      // sibling suites share the application database but never this name,
      // and it is dropped afterwards. Never the application database itself.
      const url = new URL(provisioningUrl!)
      const name = `handoff_mig_${crypto.randomUUID().slice(0, 8).replaceAll('-', '')}`
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('unsafe generated database name')
      admin = postgres(
        `${url.protocol}//${url.username}${url.password ? `:${url.password}` : ''}@${url.host}/postgres`,
        {
          max: 1,
          connect_timeout: 10,
          prepare: false,
        }
      )
      await admin.unsafe(`CREATE DATABASE "${name}"`) // validated generated name only
      url.pathname = `/${name}`
      databaseUrl = url.toString()
      // Stage the predecessor-only chain: every migration through 0050 with
      // the journal truncated there, like a database migrated before 0051
      // existed.
      staged = mkdtempSync(join(tmpdir(), 'pi-1177-mig-'))
      const sqlFiles = (await Array.fromAsync(new Bun.Glob('00*.sql').scan(repoDrizzle))).toSorted()
      const predecessor = sqlFiles.filter((file) => !file.startsWith('0051_'))
      expect(predecessor.length).toBeGreaterThan(0)
      for (const file of predecessor) cpSync(join(repoDrizzle, file), join(staged, file))
      const journal = JSON.parse(
        readFileSync(join(repoDrizzle, 'meta', '_journal.json'), 'utf8')
      ) as {
        entries: Array<{ idx: number; tag: string }>
      }
      const truncated = {
        ...journal,
        entries: journal.entries.filter((entry) => entry.idx <= 50),
      }
      expect(truncated.entries).toHaveLength(51)
      mkdirSync(join(staged, 'meta'), { recursive: true })
      writeFileSync(join(staged, 'meta', '_journal.json'), JSON.stringify(truncated, null, 2))

      first = createDatabase(databaseUrl)
      await migrate(first.db, {
        migrationsFolder: staged,
        migrationsSchema: 'app',
        migrationsTable: '__drizzle_migrations',
      })
      const applied = await first.db.execute(
        sql`SELECT count(*)::int AS n FROM app.__drizzle_migrations`
      )
      expect(applied[0]!.n as number).toBe(51)
      // Separate lifetime: close before the upgrade, like a redeployed process.
      await first.close()
      first = undefined

      second = createDatabase(databaseUrl)
      await migrate(second.db, {
        migrationsFolder: repoDrizzle,
        migrationsSchema: 'app',
        migrationsTable: '__drizzle_migrations',
      })

      const columns = await second.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'lead_turn_intents'
        AND column_name LIKE 'handoff%' ORDER BY 1`)
      expect(columns.map((row) => row.column_name as string)).toEqual([
        'handoff_target_generation',
        'handoff_target_session_id',
        'handoff_target_task_id',
      ])
      const guard = await second.db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'app.lead_turn_intents'::regclass
        AND conname = 'lead_turn_intents_handoff_target_valid'`)
      expect(guard).toHaveLength(1)
      const unique = await second.db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'app'
        AND tablename = 'lead_turn_intents'
        AND indexname = 'lead_turn_intents_target_unique'`)
      expect(unique).toHaveLength(1)
      const appliedJournal = await second.db.execute(
        sql`SELECT count(*)::int AS n FROM app.__drizzle_migrations`
      )
      expect(appliedJournal[0]!.n as number).toBe(52)
      const dupes = await second.db.execute(sql`
      SELECT hash FROM app.__drizzle_migrations GROUP BY hash HAVING count(*) > 1`)
      expect(dupes).toHaveLength(0)
    },
    120_000
  )
})
