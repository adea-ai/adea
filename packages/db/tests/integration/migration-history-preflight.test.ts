import { afterAll, describe, expect, test } from 'bun:test'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { assertDatabaseMigrationHistoryCompatible } from '../../src/migration-history-preflight'
import { cleanupScratchDatabase, throwScratchFailures } from './migration-history-preflight-scratch'

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
if (!provisioningUrl) {
  throw new Error(
    'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is required; run this proof with `bun run test:integration` so the canonical lane provisions a disposable PostgreSQL instance'
  )
}
const temporaryFolders: string[] = []
type MigrationFixture = { tag: string; when: number; sql: string }
const canonicalMigrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))
const canonicalMainMigrations = readMigrationFiles({ migrationsFolder: canonicalMigrationsFolder })

function migrationFolder(entries: MigrationFixture[]) {
  const folder = mkdtempSync(join(tmpdir(), 'migration-history-preflight-'))
  temporaryFolders.push(folder)
  mkdirSync(join(folder, 'meta'))
  for (const entry of entries) writeFileSync(join(folder, `${entry.tag}.sql`), entry.sql)
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((entry, idx) => ({
        idx,
        version: '7',
        when: entry.when,
        tag: entry.tag,
        breakpoints: true,
      })),
    })
  )
  return folder
}

async function withScratchDatabase<T>(run: (connection: DatabaseConnection) => Promise<T>) {
  const name = `migration_preflight_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('unsafe generated database name')
  const adminUrl = new URL(provisioningUrl)
  adminUrl.pathname = '/postgres'
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 10, prepare: false })
  let connection: DatabaseConnection | undefined
  let bodyFailed = false
  let bodyError: unknown
  let result: T | undefined

  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`)
    const databaseUrl = new URL(provisioningUrl)
    databaseUrl.pathname = `/${name}`
    connection = createDatabase(databaseUrl.toString())
    result = await run(connection)
  } catch (error) {
    bodyFailed = true
    bodyError = error
  }

  const cleanupErrors: unknown[] = []
  if (connection) {
    try {
      await connection.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  try {
    await cleanupScratchDatabase(admin, name)
  } catch (error) {
    cleanupErrors.push(error)
  }

  try {
    await admin.end({ timeout: 5 })
  } catch (error) {
    cleanupErrors.push(error)
  }

  throwScratchFailures(bodyFailed, bodyError, cleanupErrors)
  return result as T
}

async function readLedger(connection: DatabaseConnection) {
  const [relation] = await connection.client<Array<{ exists: boolean }>>`
    SELECT to_regclass('app.__drizzle_migrations') IS NOT NULL AS exists
  `
  if (!relation?.exists) return []
  return connection.client<Array<{ created_at: string; hash: string; id: number }>>`
    SELECT id, hash, created_at FROM app.__drizzle_migrations ORDER BY id
  `
}

async function snapshot(connection: DatabaseConnection) {
  const tables = await connection.client<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'app' ORDER BY table_name
  `
  return {
    tables: tables.map(({ table_name }) => table_name),
    ledger: await readLedger(connection),
  }
}

async function migrateFolder(connection: DatabaseConnection, folder: string) {
  await migrate(connection.db, {
    migrationsFolder: folder,
    migrationsSchema: 'app',
    migrationsTable: '__drizzle_migrations',
  })
}

const migrationFolderForTest = (entries: MigrationFixture[]) => migrationFolder(entries)

describe('migration history preflight', () => {
  afterAll(() => {
    for (const folder of temporaryFolders) rmSync(folder, { recursive: true, force: true })
    temporaryFolders.length = 0
  })

  test('accepts an empty ledger and applies the candidate chain', async () => {
    await withScratchDatabase(async (connection) => {
      const folder = migrationFolderForTest([
        {
          tag: '0001_empty_start',
          when: 1_000,
          sql: 'CREATE TABLE app.empty_start (id integer PRIMARY KEY);',
        },
      ])
      const before = await snapshot(connection)
      expect(before).toEqual({ tables: [], ledger: [] })
      await expect(
        assertDatabaseMigrationHistoryCompatible(connection, folder)
      ).resolves.toBeUndefined()
      await migrateFolder(connection, folder)
      const after = await snapshot(connection)
      expect(after.tables).toEqual(['__drizzle_migrations', 'empty_start'])
      expect(after.ledger).toHaveLength(1)
    })
  })

  test('rejects candidate timestamps that do not advance in journal order', async () => {
    await withScratchDatabase(async (connection) => {
      const before = await snapshot(connection)
      const outOfOrder = migrationFolderForTest([
        {
          tag: '0001_later',
          when: 2_000,
          sql: 'CREATE TABLE app.later_first (id integer PRIMARY KEY);',
        },
        {
          tag: '0002_earlier',
          when: 1_000,
          sql: 'CREATE TABLE app.earlier_second (id integer PRIMARY KEY);',
        },
      ])
      await expect(
        assertDatabaseMigrationHistoryCompatible(connection, outOfOrder)
      ).rejects.toThrow(/non-increasing timestamp/i)
      expect(await snapshot(connection)).toEqual(before)
    })
  })

  test('accepts an exact applied prefix and applies only the newer suffix', async () => {
    await withScratchDatabase(async (connection) => {
      const prefix = {
        tag: '0001_prefix',
        when: 1_000,
        sql: 'CREATE TABLE app.prefix (id integer PRIMARY KEY);',
      }
      const suffix = {
        tag: '0002_suffix',
        when: 2_000,
        sql: 'CREATE TABLE app.suffix (id integer PRIMARY KEY);',
      }
      await migrateFolder(connection, migrationFolderForTest([prefix]))
      const fullCandidate = migrationFolderForTest([prefix, suffix])
      await expect(
        assertDatabaseMigrationHistoryCompatible(connection, fullCandidate)
      ).resolves.toBeUndefined()
      await migrateFolder(connection, fullCandidate)
      const after = await snapshot(connection)
      expect(after.tables).toEqual(['__drizzle_migrations', 'prefix', 'suffix'])
      expect(after.ledger.map((row) => Number(row.created_at))).toEqual([1_000, 2_000])
    })
  })

  test('rejects a missing lower migration before a higher applied timestamp can suppress it', async () => {
    await withScratchDatabase(async (connection) => {
      const marker = {
        tag: '0002_marker',
        when: 2_000,
        sql: 'CREATE TABLE app.marker (id integer PRIMARY KEY);',
      }
      await migrateFolder(connection, migrationFolderForTest([marker]))
      const before = await snapshot(connection)
      const candidate = migrationFolderForTest([
        {
          tag: '0001_required',
          when: 1_000,
          sql: 'CREATE TABLE app.required (id integer PRIMARY KEY);',
        },
        marker,
        { tag: '0003_later', when: 3_000, sql: 'CREATE TABLE app.later (id integer PRIMARY KEY);' },
      ])
      await expect(assertDatabaseMigrationHistoryCompatible(connection, candidate)).rejects.toThrow(
        /would be skipped|below.*applied/i
      )
      expect(await snapshot(connection)).toEqual(before)
    })
  })

  test('accepts the complete canonical main migration history', async () => {
    await withScratchDatabase(async (connection) => {
      expect(canonicalMainMigrations.length).toBeGreaterThan(0)
      await migrateFolder(connection, canonicalMigrationsFolder)
      expect(await readLedger(connection)).toHaveLength(canonicalMainMigrations.length)
      await expect(
        assertDatabaseMigrationHistoryCompatible(connection, canonicalMigrationsFolder)
      ).resolves.toBeUndefined()
    })
  })

  test('rejects missing lower entries beneath the latest canonical main migration', async () => {
    await withScratchDatabase(async (connection) => {
      const latest = canonicalMainMigrations.at(-1)
      expect(latest).toBeDefined()
      await connection.client`CREATE SCHEMA app`
      await connection.client`
        CREATE TABLE app.__drizzle_migrations (
          id serial PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint NOT NULL
        )
      `
      await connection.client`
        INSERT INTO app.__drizzle_migrations(hash, created_at)
        VALUES (${latest!.hash}, ${latest!.folderMillis})
      `
      const before = await snapshot(connection)

      await expect(
        assertDatabaseMigrationHistoryCompatible(connection, canonicalMigrationsFolder)
      ).rejects.toThrow(/would be skipped below the applied timestamp/i)
      expect(await snapshot(connection)).toEqual(before)
    })
  })

  test('rejects an applied SQL hash moved to a newer timestamp without changing schema or ledger', async () => {
    await withScratchDatabase(async (connection) => {
      const sql = 'CREATE TABLE app.already_applied (id integer PRIMARY KEY);'
      await migrateFolder(
        connection,
        migrationFolderForTest([{ tag: '0001_applied', when: 4_000, sql }])
      )
      const before = await snapshot(connection)
      const retimed = migrationFolderForTest([{ tag: '0001_applied_retimed', when: 5_000, sql }])
      await expect(assertDatabaseMigrationHistoryCompatible(connection, retimed)).rejects.toThrow(
        /moved|timestamp changed|different timestamp/i
      )
      expect(await snapshot(connection)).toEqual(before)
    })
  })

  test('rejects an applied hash missing from the candidate without changing schema or ledger', async () => {
    await withScratchDatabase(async (connection) => {
      await migrateFolder(
        connection,
        migrationFolderForTest([
          {
            tag: '0001_applied',
            when: 4_000,
            sql: 'CREATE TABLE app.applied (id integer PRIMARY KEY);',
          },
        ])
      )
      const before = await snapshot(connection)
      const candidate = migrationFolderForTest([
        {
          tag: '0001_replacement',
          when: 5_000,
          sql: 'CREATE TABLE app.replacement (id integer PRIMARY KEY);',
        },
      ])

      await expect(assertDatabaseMigrationHistoryCompatible(connection, candidate)).rejects.toThrow(
        /applied ledger row .* does not match a candidate migration/i
      )
      expect(await snapshot(connection)).toEqual(before)
    })
  })

  test('rejects a duplicate applied ledger hash and timestamp without changing schema or ledger', async () => {
    await withScratchDatabase(async (connection) => {
      const applied = {
        tag: '0001_applied',
        when: 4_000,
        sql: 'CREATE TABLE app.applied_once (id integer PRIMARY KEY);',
      }
      const candidate = migrationFolderForTest([applied])
      await migrateFolder(connection, candidate)
      const [ledgerEntry] = await readLedger(connection)
      await connection.client`
        INSERT INTO app.__drizzle_migrations(hash, created_at)
        VALUES (${ledgerEntry!.hash}, ${ledgerEntry!.created_at})
      `
      const before = await snapshot(connection)

      await expect(assertDatabaseMigrationHistoryCompatible(connection, candidate)).rejects.toThrow(
        /duplicates an applied migration/i
      )
      expect(await snapshot(connection)).toEqual(before)
    })
  })

  test('rejects an applied hash that maps ambiguously to multiple journal entries', async () => {
    await withScratchDatabase(async (connection) => {
      const sql = 'CREATE TABLE app.ambiguous (id integer PRIMARY KEY);'
      await migrateFolder(
        connection,
        migrationFolderForTest([{ tag: '0001_applied', when: 4_000, sql }])
      )
      const before = await snapshot(connection)
      const ambiguous = migrationFolderForTest([
        { tag: '0001_applied', when: 4_000, sql },
        { tag: '0002_duplicate_sql', when: 5_000, sql },
      ])
      await expect(assertDatabaseMigrationHistoryCompatible(connection, ambiguous)).rejects.toThrow(
        /ambiguous/i
      )
      expect(await snapshot(connection)).toEqual(before)
    })
  })
})
