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
//
// Every client in this file (pg, pg_dump, pg_restore) is pointed at one target
// that is validated once: a loopback host and no query parameters, so no libpq
// routing override (host, hostaddr, service) can move a client elsewhere. Tool
// processes receive a fixed, minimal environment, and every subprocess and
// database operation is bounded. Cleanup attempts each owned step independently.

const databaseUrl = process.env.AUTH_POSTGRES_TEST_URL
const origin = 'http://127.0.0.1:8787'
const secret = 'disposable-backup-restore-integration-secret-long-enough'
const expectedTables = ['account', 'session', 'user', 'verification']
const at = '2026-10-01T00:00:00.000Z'
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const ROUTING_ENVIRONMENT_NAMES = ['PGHOST', 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']
const TOOL_ENVIRONMENT_NAMES = ['PATH', 'HOME', 'TMPDIR', 'LANG']
const TOOL_TIMEOUT_MS = 120_000
const CLEANUP_TIMEOUT_MS = 15_000
const POOL_OPTIONS = { connectionTimeoutMillis: 10_000, max: 1, query_timeout: 30_000 }

const suffix = crypto.randomUUID().replaceAll('-', '')
const schema = `auth_bkp_${suffix}`
const restoredDatabase = `auth_bkp_restore_${suffix}`
let target: URL | undefined
let workDirectory: string | undefined
let admin: Pool | undefined

/**
 * Validates the one disposable target. It must use a PostgreSQL scheme, name a
 * loopback host, and carry no query parameters, so no libpq routing override can
 * apply. Returns a copy that every client in this file derives its URL from.
 */
export function loopbackTargetOf(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('AUTH_POSTGRES_TEST_URL is not a valid URL')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('the target must use the postgresql scheme')
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new Error('the target host must be localhost, 127.0.0.1 or [::1]')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('the target must carry no query or fragment, so no routing override can apply')
  }
  if (!parsed.username) throw new Error('the target must name a role')
  return new URL(parsed.toString())
}

/** One URL for one database, optionally pinned to a search_path. Derived only from `target`. */
function urlFor(validated: URL, database: string, searchPath?: string): string {
  const url = new URL(validated.toString())
  url.pathname = `/${database}`
  if (searchPath) url.searchParams.set('options', `-c search_path=${searchPath}`)
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

function poolFor(url: string): Pool {
  return new Pool({ connectionString: url, ...POOL_OPTIONS })
}

/** A fixed environment for child tools, so no inherited PG* variable can route them. */
function toolEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of TOOL_ENVIRONMENT_NAMES) {
    const value = process.env[name]
    if (value) environment[name] = value
  }
  return environment
}

/** Runs a child process, kills it at the deadline, and reaps it before returning. */
async function runBounded(command: string[], timeoutMs: number) {
  const child = Bun.spawn(command, { env: toolEnvironment(), stderr: 'pipe', stdout: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  try {
    const [stderr] = await Promise.all([
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    const code = await child.exited
    return { code, pid: child.pid, stderr, timedOut }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

async function runTool(command: string[]): Promise<{ code: number; stderr: string }> {
  const result = await runBounded(command, TOOL_TIMEOUT_MS)
  if (result.timedOut) {
    throw new Error(`${command[0]} exceeded ${TOOL_TIMEOUT_MS} ms and was killed`)
  }
  return { code: result.code, stderr: result.stderr }
}

/** Resolves or rejects with the work, or rejects once the deadline passes. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Attempts every cleanup step, even after one fails or stalls. Returns one line
 * per failed step, so the caller reports all of them and loses none.
 */
export async function runCleanups(
  steps: ReadonlyArray<readonly [string, () => Promise<unknown>]>,
  timeoutMs = CLEANUP_TIMEOUT_MS
): Promise<string[]> {
  const failures: string[] = []
  for (const [label, step] of steps) {
    try {
      await withDeadline(Promise.resolve().then(step), timeoutMs)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unexpected non-error failure'
      failures.push(`${label}: ${reason}`)
    }
  }
  return failures
}

async function tablesIn(schemaName: string): Promise<string[]> {
  const rows = await admin!.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
    [schemaName]
  )
  return rows.rows.map((row) => row.table_name)
}

// Everything a restore must reproduce: column definitions, row counts and every row.
async function snapshotOf(url: string, schemaName: string) {
  const pool = poolFor(url)
  try {
    const columns = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schemaName]
    )
    const counts: Record<string, number> = {}
    const rows: Record<string, unknown[]> = {}
    for (const table of expectedTables) {
      const count = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${schemaName}"."${table}"`
      )
      counts[table] = count.rows[0]?.n ?? -1
      rows[table] = (await pool.query(`SELECT * FROM "${schemaName}"."${table}" ORDER BY id`)).rows
    }
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [schemaName]
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

describe('loopback target guard and bounded cleanup (no database needed)', () => {
  test.each([
    'postgresql://u:p@127.0.0.1:5432/db?host=/var/run/postgresql',
    'postgresql://u:p@127.0.0.1:5432/db?hostaddr=10.0.0.5',
    'postgresql://u:p@127.0.0.1:5432/db?service=production',
    'postgresql://u:p@127.0.0.1:5432/db?options=-c%20host%3Dexample.test',
    'postgresql://u:p@127.0.0.1:5432/db#fragment',
    'postgresql://u:p@db.example.test:5432/db',
    'postgresql://u:p@[::ffff:10.0.0.1]:5432/db',
    'postgresql://u:p@127.0.0.1,db.example.test/db',
    'postgresql://127.0.0.1:5432/db',
    'mysql://u:p@127.0.0.1:5432/db',
  ])('refuses %s', (rawUrl) => {
    expect(() => loopbackTargetOf(rawUrl)).toThrow()
  })

  test.each([
    ['postgresql://u:p@localhost:5432/db', 'localhost'],
    ['postgresql://u:p@127.0.0.1:5432/db', '127.0.0.1'],
    ['postgresql://u:p@[::1]:5432/db', '[::1]'],
  ])('accepts %s and derives every URL from it', (rawUrl, hostname) => {
    const validated = loopbackTargetOf(rawUrl)
    expect(validated.hostname).toBe(hostname)
    const derived = new URL(urlFor(validated, 'restored', 'auth_schema'))
    expect(derived.hostname).toBe(hostname)
    expect(derived.pathname).toBe('/restored')
    expect([...derived.searchParams.keys()]).toEqual(['options'])
  })

  test('a subprocess that stalls is killed at its deadline and reaped', async () => {
    const result = await runBounded(['sleep', '30'], 200)
    expect(result.timedOut).toBe(true)
    expect(() => process.kill(result.pid, 0)).toThrow()
  }, 10_000)

  test('a failing cleanup step does not stop the others, and its failure is reported', async () => {
    const ran: string[] = []
    const failures = await runCleanups([
      [
        'first',
        async () => {
          throw new Error('boom')
        },
      ],
      [
        'second',
        async () => {
          ran.push('second')
        },
      ],
    ])
    expect(ran).toEqual(['second'])
    expect(failures).toEqual(['first: boom'])
  })

  test('a stalled cleanup step is abandoned at its deadline and the next one still runs', async () => {
    const ran: string[] = []
    const failures = await runCleanups(
      [
        ['stalled', () => new Promise(() => {})],
        [
          'after',
          async () => {
            ran.push('after')
          },
        ],
      ],
      50
    )
    expect(ran).toEqual(['after'])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('stalled: timed out after 50 ms')
  }, 10_000)
})

describe.skipIf(!databaseUrl)('schema backup and restore (PostgreSQL, synthetic data)', () => {
  beforeAll(async () => {
    for (const name of ROUTING_ENVIRONMENT_NAMES) {
      if (process.env[name]) {
        throw new Error(`${name} is set; unset routing variables before this disposable test`)
      }
    }
    target = loopbackTargetOf(databaseUrl!)
    for (const tool of ['pg_dump', 'pg_restore']) {
      if (!Bun.which(tool)) throw new Error(`${tool} must be on PATH for this test`)
    }
    workDirectory = mkdtempSync(join(tmpdir(), 'auth-backup-restore-'))
    admin = poolFor(target.toString())
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE DATABASE "${restoredDatabase}"`)
  }, 60_000)

  afterAll(async () => {
    const steps: Array<readonly [string, () => Promise<unknown>]> = []
    if (admin) {
      const pool = admin
      steps.push(
        [
          'drop restored database',
          () => pool.query(`DROP DATABASE IF EXISTS "${restoredDatabase}" WITH (FORCE)`),
        ],
        ['drop schema', () => pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)],
        ['close admin pool', () => pool.end()]
      )
    }
    if (workDirectory) {
      const directory = workDirectory
      steps.push([
        'remove work directory',
        async () => rmSync(directory, { recursive: true, force: true }),
      ])
    }
    const failures = await runCleanups(steps)
    admin = undefined
    workDirectory = undefined
    if (failures.length > 0) throw new Error(`cleanup did not finish: ${failures.join('; ')}`)
  }, 60_000)

  test('a fresh schema is dumped and restored with the same tables, columns and rows, and nothing pending', async () => {
    const validated = target!
    const sourceConnection = urlFor(validated, validated.pathname.slice(1))
    const sourceSearchPath = urlFor(validated, validated.pathname.slice(1), schema)
    const restoredConnection = urlFor(validated, restoredDatabase)

    // 1. Create the schema with the explicit initializer, then fill it with synthetic rows.
    const applied = await applyAuthSchema(environmentFor(sourceSearchPath))
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
      environmentFor(urlFor(validated, restoredDatabase, schema))
    )
    expect(planned.applied).toBe(false)
    expect(planned.before).toEqual({ add: [], create: [] })
    const after = await snapshotOf(restoredConnection, schema)
    expect(after.counts).toEqual(source.counts)
    expect(await tablesIn(schema)).toEqual(expectedTables)
  }, 120_000)
})
