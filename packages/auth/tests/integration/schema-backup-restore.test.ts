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
// Every client in this file (pg, pg_dump, pg_restore, and the auth initializer's
// own pool) is pointed at one target that is validated once: a loopback host, a
// TLS mode and an optional certificate path as the only query parameters, so no
// libpq routing override (host, hostaddr, service, passfile) can move a client.
// Every derived URL also carries server-side statement and lock bounds. Tool
// processes receive a fixed, minimal environment. Every subprocess and database
// operation is bounded, and every live child is reaped in cleanup.

const databaseUrl = process.env.AUTH_POSTGRES_TEST_URL
const origin = 'http://127.0.0.1:8787'
const secret = 'disposable-backup-restore-integration-secret-long-enough'
const expectedTables = ['account', 'session', 'user', 'verification']
const at = '2026-10-01T00:00:00.000Z'
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const ALLOWED_QUERY_NAMES = new Set(['sslmode', 'sslrootcert'])
const TLS_MODES = new Set(['require', 'verify-ca', 'verify-full'])
const ROUTING_ENVIRONMENT_NAMES = ['PGHOST', 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']
const TOOL_ENVIRONMENT_NAMES = ['PATH', 'HOME', 'TMPDIR', 'LANG']

// Every operation has a bounded budget. The test's own deadline is the sum of
// those budgets, so it can only fire after every bounded step has finished.
const TOOL_TIMEOUT_MS = 60_000
const DB_QUERY_TIMEOUT_MS = 10_000
const CLEANUP_TIMEOUT_MS = 15_000
const CLEANUP_STEPS = 4
const BODY_TOOL_CALLS = 2
const BODY_DB_QUERIES = 60
const TEST_BUDGET_MS =
  BODY_TOOL_CALLS * TOOL_TIMEOUT_MS +
  BODY_DB_QUERIES * DB_QUERY_TIMEOUT_MS +
  CLEANUP_STEPS * CLEANUP_TIMEOUT_MS
const BEFORE_ALL_BUDGET_MS = 2 * DB_QUERY_TIMEOUT_MS + 10_000
const AFTER_ALL_BUDGET_MS = CLEANUP_STEPS * CLEANUP_TIMEOUT_MS + 5_000

// Server-side bounds on every connection this test derives, including the ones the
// auth initializer opens for itself, so a stalled server cannot hold a client.
const SERVER_BOUNDS = [
  `-c statement_timeout=${DB_QUERY_TIMEOUT_MS}`,
  '-c lock_timeout=5000',
  '-c idle_in_transaction_session_timeout=30000',
].join(' ')
const CONNECT_TIMEOUT_SECONDS = 10
const POOL_OPTIONS = { connectionTimeoutMillis: 10_000, max: 1, query_timeout: DB_QUERY_TIMEOUT_MS }

const suffix = crypto.randomUUID().replaceAll('-', '')
const schema = `auth_bkp_${suffix}`
const restoredDatabase = `auth_bkp_restore_${suffix}`
let target: URL | undefined
let workDirectory: string | undefined
let admin: Pool | undefined
const liveChildren = new Set<ReturnType<typeof Bun.spawn>>()

/**
 * Validates the one disposable target. It must use a PostgreSQL scheme, name a
 * loopback host and carry no fragment. Its only query parameters may be a TLS
 * mode and a certificate path, which are not routing overrides. Returns a copy
 * that every client in this file derives its URL from.
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
  if (parsed.hash !== '') throw new Error('the target must carry no fragment')
  for (const name of new Set(parsed.searchParams.keys())) {
    if (!ALLOWED_QUERY_NAMES.has(name)) {
      throw new Error(`the target may not set ${name}; no routing override is accepted`)
    }
    if (parsed.searchParams.getAll(name).length > 1) {
      throw new Error(`the target may not repeat ${name}`)
    }
  }
  const mode = parsed.searchParams.get('sslmode')
  if (mode !== null && !TLS_MODES.has(mode)) throw new Error('the target sslmode is not accepted')
  if (!parsed.username) throw new Error('the target must name a role')
  return new URL(parsed.toString())
}

/**
 * One URL for one database, bounded on the server and optionally pinned to a
 * search_path. Derived only from `target`, and it never adds a routing parameter.
 * The connect timeout bounds the TCP and TLS handshake that the server bounds
 * cannot reach, for the auth initializer's own pools as well as the tools.
 */
function urlFor(validated: URL, database: string, searchPath?: string): string {
  const url = new URL(validated.toString())
  url.pathname = `/${database}`
  const options = searchPath ? `${SERVER_BOUNDS} -c search_path=${searchPath}` : SERVER_BOUNDS
  // Percent-encode by hand: URLSearchParams writes spaces as '+', which libpq reads literally.
  const kept = [...url.searchParams.entries()]
    .filter(([name]) => name !== 'options' && name !== 'connect_timeout')
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
  kept.push(`connect_timeout=${CONNECT_TIMEOUT_SECONDS}`)
  kept.push(`options=${encodeURIComponent(options)}`)
  url.search = kept.join('&')
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

/**
 * Runs a child process under a deadline. A live child is killed on every exit
 * path, and its exit is awaited before this returns, so nothing outlives the call.
 */
async function runBounded(command: string[], timeoutMs: number) {
  const child = Bun.spawn(command, { env: toolEnvironment(), stderr: 'pipe', stdout: 'pipe' })
  liveChildren.add(child)
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
    await child.exited.catch(() => undefined)
    liveChildren.delete(child)
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

/**
 * One cleanup statement on its own connection, so an earlier step that stalled
 * cannot hold the connection a later step needs. The server's statement bound
 * ends any stalled statement before the step's own deadline.
 */
async function runOwnStatement(sql: string): Promise<void> {
  const pool = poolFor(target!.toString())
  try {
    await pool.query(sql)
  } finally {
    await pool.end().catch(() => undefined)
  }
}

/** Kills and reaps every child this file still owns. Used by cleanup as a backstop. */
async function reapLiveChildren(): Promise<void> {
  const reaped = [...liveChildren].map((child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    return child.exited.catch(() => undefined)
  })
  await Promise.all(reaped)
  liveChildren.clear()
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
    'postgresql://u:p@127.0.0.1:5432/db?passfile=/tmp/pass',
    'postgresql://u:p@127.0.0.1:5432/db?options=-c%20host%3Dexample.test',
    'postgresql://u:p@127.0.0.1:5432/db?sslmode=disable',
    'postgresql://u:p@127.0.0.1:5432/db?sslmode=verify-full&sslmode=require',
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
    ['postgresql://u:p@[::1]:5432/db?sslmode=verify-full&sslrootcert=/tmp/ca.crt', '[::1]'],
  ])('accepts %s and derives every URL from it', (rawUrl, hostname) => {
    const validated = loopbackTargetOf(rawUrl)
    expect(validated.hostname).toBe(hostname)
    const derived = new URL(urlFor(validated, 'restored', 'auth_schema'))
    expect(derived.hostname).toBe(hostname)
    expect(derived.pathname).toBe('/restored')
    expect(derived.search).not.toContain('+')
    const options = decodeURIComponent(derived.search.split('options=')[1] ?? '')
    expect(options).toContain(`-c statement_timeout=${DB_QUERY_TIMEOUT_MS}`)
    expect(options).toContain('-c search_path=auth_schema')
    expect(derived.searchParams.get('sslmode')).toBe(validated.searchParams.get('sslmode'))
  })

  test('a subprocess that stalls is killed at its deadline and reaped', async () => {
    const result = await runBounded(['sleep', '30'], 200)
    expect(result.timedOut).toBe(true)
    expect(() => process.kill(result.pid, 0)).toThrow()
    expect(liveChildren.size).toBe(0)
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
  }, BEFORE_ALL_BUDGET_MS)

  afterAll(async () => {
    const steps: Array<readonly [string, () => Promise<unknown>]> = [
      ['reap live tool processes', reapLiveChildren],
      [
        'drop restored database',
        () => runOwnStatement(`DROP DATABASE IF EXISTS "${restoredDatabase}" WITH (FORCE)`),
      ],
      ['drop schema', () => runOwnStatement(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)],
    ]
    if (admin) {
      const pool = admin
      steps.push(['close admin pool', () => pool.end()])
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
  }, AFTER_ALL_BUDGET_MS)

  test(
    'a fresh schema is dumped and restored with the same tables, columns and rows, and nothing pending',
    async () => {
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
      expect({ code: dumped.code, stderr: dumped.stderr }).toEqual({ code: 0, stderr: '' })

      const restored = await runTool([
        'pg_restore',
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        `--dbname=${restoredConnection}`,
        dumpFile,
      ])
      expect({ code: restored.code }).toEqual({ code: 0 })

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
    },
    TEST_BUDGET_MS
  )
})
