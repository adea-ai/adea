import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'

import { applyAuthSchema, planAuthSchema } from '../../src/schema-init'

// Runs against a disposable loopback PostgreSQL only. It creates one schema and
// one restore database, fills them with synthetic fresh-account rows, and drops
// both in cleanup. Ownership and grants are not restored (--no-owner), so this
// test proves table, column and row fidelity, not role or privilege fidelity.
const databaseUrl = process.env.AUTH_POSTGRES_TEST_URL
const origin = 'http://127.0.0.1:8787'
const secret = 'disposable-backup-restore-integration-secret-long-enough'
const expectedTables = ['account', 'session', 'user', 'verification']
const at = '2026-10-01T00:00:00.000Z'

const suffix = crypto.randomUUID().replaceAll('-', '')
const schema = `auth_bkp_${suffix}`
const restoredDatabase = `auth_bkp_restore_${suffix}`
let workDirectory: string | undefined
let admin: Pool | undefined

function withTarget(rawUrl: string, database: string, rawSearchPath?: string): string {
  const url = new URL(rawUrl)
  url.pathname = `/${database}`
  if (rawSearchPath) url.searchParams.set('options', `-c search_path=${rawSearchPath}`)
  return url.toString()
}

function environmentFor(migrationUrl: string): Record<string, string> {
  return {
    AUTH_BASE_URL: origin,
    AUTH_MIGRATION_DATABASE_URL: migrationUrl,
    AUTH_SECRET: secret,
    AUTH_SECURE_COOKIES: 'false',
    AUTH_TRUSTED_ORIGINS: origin,
  }
}

async function runTool(command: string[]): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn(command, { stderr: 'pipe', stdout: 'pipe' })
  const [stderr] = await Promise.all([
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  return { code: await child.exited, stderr }
}

// Everything a restore must reproduce: column definitions, row counts and every row.
async function snapshotOf(url: string, target: string) {
  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    const columns = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [target]
    )
    const counts: Record<string, number> = {}
    const rows: Record<string, unknown[]> = {}
    for (const table of expectedTables) {
      const count = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${target}"."${table}"`
      )
      counts[table] = count.rows[0]?.n ?? -1
      rows[table] = (await pool.query(`SELECT * FROM "${target}"."${table}" ORDER BY id`)).rows
    }
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [target]
    )
    return {
      columns: columns.rows,
      counts,
      rows,
      tables: tables.rows.map((row) => row.table_name),
    }
  } finally {
    await pool.end()
  }
}

describe.skipIf(!databaseUrl)('schema backup and restore (PostgreSQL, synthetic data)', () => {
  beforeAll(async () => {
    const target = new URL(databaseUrl!)
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname)) {
      throw new Error('AUTH_POSTGRES_TEST_URL must use a loopback host and a disposable database')
    }
    for (const tool of ['pg_dump', 'pg_restore']) {
      if (!Bun.which(tool)) throw new Error(`${tool} must be on PATH for this test`)
    }
    workDirectory = mkdtempSync(join(tmpdir(), 'auth-backup-restore-'))
    admin = new Pool({ connectionString: databaseUrl, max: 1 })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE DATABASE "${restoredDatabase}"`)
  }, 60_000)

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${restoredDatabase}" WITH (FORCE)`)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.end()
      admin = undefined
    }
    if (workDirectory) rmSync(workDirectory, { recursive: true, force: true })
  }, 60_000)

  test('a fresh schema is dumped and restored with the same tables, columns and rows, and nothing pending', async () => {
    const sourceUrl = withTarget(databaseUrl!, new URL(databaseUrl!).pathname.slice(1), schema)
    const sourceConnection = withTarget(databaseUrl!, new URL(databaseUrl!).pathname.slice(1))
    const restoredConnection = withTarget(databaseUrl!, restoredDatabase)
    const sourceEnvironment = environmentFor(sourceUrl)

    // 1. Create the schema with the explicit initializer, then fill it with synthetic rows.
    const applied = await applyAuthSchema(sourceEnvironment)
    expect(applied.applied).toBe(true)
    expect(applied.after).toEqual({ add: [], create: [] })

    await admin!.query(
      `INSERT INTO "${schema}"."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ('synthetic-user-1', 'Synthetic One', 'synthetic-1@example.test', true, $1, $1),
              ('synthetic-user-2', 'Synthetic Two', 'synthetic-2@example.test', false, $1, $1)`,
      [at]
    )
    await admin!.query(
      `INSERT INTO "${schema}".session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES ('synthetic-session-1', $1, 'synthetic-token-1', $1, $1, 'synthetic-user-1')`,
      [at]
    )
    await admin!.query(
      `INSERT INTO "${schema}".account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
       VALUES ('synthetic-account-1', 'synthetic-subject-1', 'synthetic-provider', 'synthetic-user-1', $1, $1)`,
      [at]
    )
    await admin!.query(
      `INSERT INTO "${schema}".verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
       VALUES ('synthetic-verification-1', 'synthetic-1@example.test', 'synthetic-value-1', $1, $1, $1)`,
      [at]
    )
    const source = await snapshotOf(sourceConnection, schema)
    expect(source.tables).toEqual(expectedTables)
    expect(source.counts).toEqual({ account: 1, session: 1, user: 2, verification: 1 })

    // 2. Dump only the schema in custom format, then restore it into an empty database.
    const dumpFile = join(workDirectory!, 'schema.dump')
    const dumped = await runTool([
      'pg_dump',
      '--format=custom',
      `--schema=${schema}`,
      `--file=${dumpFile}`,
      `--dbname=${sourceConnection}`,
    ])
    expect(dumped.code).toBe(0)
    expect(dumped.stderr).toBe('')

    const restored = await runTool([
      'pg_restore',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      `--dbname=${restoredConnection}`,
      dumpFile,
    ])
    expect(restored.code).toBe(0)

    // 3. The restored schema matches the source exactly: tables, columns, counts and rows.
    const copy = await snapshotOf(restoredConnection, schema)
    expect(copy.tables).toEqual(source.tables)
    expect(copy.columns).toEqual(source.columns)
    expect(copy.counts).toEqual(source.counts)
    expect(copy.rows).toEqual(source.rows)

    // 4. The restored schema reports no pending work, and planning writes nothing.
    const planned = await planAuthSchema(
      environmentFor(withTarget(databaseUrl!, restoredDatabase, schema))
    )
    expect(planned.applied).toBe(false)
    expect(planned.before).toEqual({ add: [], create: [] })
    const after = await snapshotOf(restoredConnection, schema)
    expect(after.counts).toEqual(source.counts)
  }, 120_000)
})
