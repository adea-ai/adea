import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'

// Runs against a disposable loopback PostgreSQL only. It creates one schema and
// one restore database, fills them with synthetic fresh-account rows, and drops
// both in cleanup. Ownership and grants are not restored (--no-owner), so this
// test proves table, column and row fidelity, not role or privilege fidelity.
//
// The proof covers the application schema as well as the auth schema. The
// disposable lane migrates the application schema into the same instance before
// this file runs, so one dump now carries both schemas and one restore lands
// both. The application schema's tables, columns, per-table row counts, the
// seeded data rows and the migration ledger are compared source against
// restored, and a restored target whose ledger was altered is refused by the
// database package's own migration-history preflight. The ledger is the target
// identity the current schema exposes; no other identity is invented here.
//
// The schema objects are compared as well, because the tables and the columns
// do not carry them: the restored application schema is compared index by
// index, constraint by constraint, function by function, trigger by trigger and
// sequence by sequence, so a restore that lost an object the product relies on
// cannot pass as a clean copy. The objects are compared by their definitions,
// which the restore reproduces exactly: the application schema's definitions
// are schema-qualified, so a restored definition and a source definition are
// the same text. A sequence's current value is data, not a definition, and is
// deliberately not compared.
//
// The objects are not only compared, they are exercised. The restored target
// refuses a second write to a rollback fence's attribution, which is the
// trigger's own refusal, and it refuses a second admission for the same target
// context, which is the unique index's own refusal. The restored target is
// also accepted by the database package's own migration-history preflight
// before its ledger is altered, so the proof shows a restored target that the
// product's own tooling accepts, not only one that a comparison accepts.
//
// The fixture the behaviour proof owns lives in the restored target only and is
// removed again before the comparison that follows, so the restored target is
// left exactly as the restore made it and the source target is never written
// to at all.
//
// This is a DATA restoration proof. It says nothing about the runtime's
// no-send behaviour, about a session generation, or about who may restore a
// production database: the runtime owns the session and its monotonic
// generation, the ledger only says which schema version a database carries, and
// the restore authority for a hosted database is a separate decision. A green
// proof here is not a no-send proof and not a generation-authority proof.
//
// Every client in this file (pg, pg_dump, pg_restore, the auth initializer's
// own pool and the database package's migration verifier) is pointed at one
// target that is validated once: a loopback host, a TLS mode and an optional
// certificate path as the only query parameters, so no libpq routing override
// (host, hostaddr, service, passfile) can move a client. Every derived URL also
// carries server-side statement and lock bounds, including the admin and
// cleanup connections. The auth initializer opens its own pool, which no
// client-side timeout of this test can reach, so it runs in a child process that
// is killed at its deadline. The application driver (postgres.js) encrypts
// without verifying, exactly as the hosted lane does, so the verifier child
// connects with sslmode=require while the libpq clients keep the pinned
// certificate. Tool processes receive a fixed, minimal environment. Every
// subprocess and database operation is bounded, and every live child is reaped
// in cleanup.

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
// those budgets, so it can only fire after every bounded step has finished. The
// disposable proof runs this file under a 600000 ms spawnSync ceiling
// (scripts/disposable-postgres-cli.ts), which kills the whole run at that point, so
// the budgets below must fit inside it with a margin. A real run takes seconds.
const OUTER_COMMAND_CEILING_MS = 600_000
const OUTER_MARGIN_MS = 15_000
const TOOL_TIMEOUT_MS = 30_000
const DB_QUERY_TIMEOUT_MS = 5_000
const CLEANUP_TIMEOUT_MS = 10_000
const CLEANUP_STEPS = 5
// The body tests: the dump and restore test, the application-schema test and the
// restored-behaviour test. Pg_dump, pg_restore, the two initializer runs, the
// migration verifier and the positive preflight are each a bounded child
// process; the forty-three statements are the bounded queries the body runs.
const BODY_TOOL_CALLS = 6
const BODY_DB_QUERIES = 43
// The body tests' own deadline: the sum of their bounded steps, so it can only
// fire after every bounded step has finished. The cleanup steps are not part of
// it: they run in `afterAll`, under the after-all budget below, and counting
// them here as well counted the same work twice.
const TEST_BUDGET_MS = BODY_TOOL_CALLS * TOOL_TIMEOUT_MS + BODY_DB_QUERIES * DB_QUERY_TIMEOUT_MS
// The restored-behaviour test's own deadline: one verifier child and the five
// statements of the behaviour proof. Its steps are inside the body's budget
// above, so the worst case below does not count them twice.
const RESTORED_BEHAVIOUR_BUDGET_MS = 1 * TOOL_TIMEOUT_MS + 5 * DB_QUERY_TIMEOUT_MS
const BEFORE_ALL_BUDGET_MS = 2 * DB_QUERY_TIMEOUT_MS + 10_000
const AFTER_ALL_BUDGET_MS = CLEANUP_STEPS * CLEANUP_TIMEOUT_MS + 5_000
// The blocked-lock test: an admin DDL, the holder's lock, and one cleanup statement.
const BLOCKED_TEST_BUDGET_MS = 60_000
// The loopback guard and the stalled-child tests, all of which finish in seconds.
const UNCONDITIONAL_BUDGET_MS = 30_000
const RUNNER = join(import.meta.dir, 'schema-init-runner.ts')

// Server-side bounds on every connection this test derives, including the ones the
// auth initializer opens for itself, so a stalled server cannot hold a client.
// The server bounds end a statement before the client's own query deadline does, so
// the server cancels the work and the connection is not left mid-statement. The
// guard test below asserts that ordering.
const SERVER_STATEMENT_TIMEOUT_MS = DB_QUERY_TIMEOUT_MS - 1_000
const SERVER_LOCK_TIMEOUT_MS = 2_000
const SERVER_BOUNDS = [
  `-c statement_timeout=${SERVER_STATEMENT_TIMEOUT_MS}`,
  `-c lock_timeout=${SERVER_LOCK_TIMEOUT_MS}`,
  '-c idle_in_transaction_session_timeout=30000',
].join(' ')
const CONNECT_TIMEOUT_SECONDS = 10
const POOL_OPTIONS = { connectionTimeoutMillis: 10_000, max: 1, query_timeout: DB_QUERY_TIMEOUT_MS }
type InitializerResult = {
  applied: boolean
  before: { add: string[]; create: string[] }
  after?: { add: string[]; create: string[] }
}

const suffix = crypto.randomUUID().replaceAll('-', '')
const schema = `auth_bkp_${suffix}`
const restoredDatabase = `auth_bkp_restore_${suffix}`
/**
 * The application schema the disposable lane migrates into the same instance
 * before this file runs. Its ledger (`app.__drizzle_migrations`) is the target
 * identity the schema exposes: a database whose ledger is not the source's is a
 * different target, and the database package's own migration-history preflight
 * refuses it.
 */
const applicationSchema = 'app'
const applicationLedger = `${applicationSchema}.__drizzle_migrations`
/** The seeded rows this run owns, named from this run's own identifiers. */
const seededUserId = crypto.randomUUID()
const seededWorkspaceId = crypto.randomUUID()
const seededIdempotencyKey = `restore-proof-${suffix}`
/** The repository root, for the one child process that runs the database package. */
const repositoryRoot = join(import.meta.dir, '../../../..')
const migrationFolder = join(repositoryRoot, 'packages/db/drizzle')
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

/** The admin connection, derived from the validated target like every other one. */
function adminUrl(): string {
  return urlFor(target!, target!.pathname.slice(1))
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
async function runBounded(
  command: string[],
  timeoutMs: number,
  environment: Record<string, string> = toolEnvironment()
) {
  const child = Bun.spawn(command, { env: environment, stderr: 'pipe', stdout: 'pipe' })
  liveChildren.add(child)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  try {
    const [stderr, stdout] = await Promise.all([
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    const code = await child.exited
    return { code, pid: child.pid, stderr, stdout, timedOut }
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
  const pool = poolFor(adminUrl())
  try {
    await pool.query(sql)
  } finally {
    await pool.end().catch(() => undefined)
  }
}

/**
 * Runs the auth initializer in its own child process, under a deadline. Its pool is
 * created inside that process, so a stalled server ends with the process kill.
 */
async function runInitializer(
  action: 'apply' | 'plan',
  migrationUrl: string
): Promise<InitializerResult> {
  const result = await runBounded([process.execPath, '--no-env-file', RUNNER], TOOL_TIMEOUT_MS, {
    ...toolEnvironment(),
    ...environmentFor(migrationUrl),
    AUTH_RUNNER_ACTION: action,
  })
  if (result.timedOut) {
    throw new Error(
      `the auth initializer (${action}) exceeded ${TOOL_TIMEOUT_MS} ms and was killed`
    )
  }
  if (result.code !== 0) {
    throw new Error(
      `the auth initializer (${action}) failed with exit code ${result.code}: ${result.stderr.trim().slice(0, 500)}`
    )
  }
  return JSON.parse(result.stdout) as InitializerResult
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

/**
 * One URL for the application driver (postgres.js), which encrypts without
 * verifying and therefore cannot use the pinned certificate: the disposable
 * lane's own application URLs are `sslmode=require` for the same reason. The
 * libpq clients in this file keep the certificate. No routing parameter is
 * added, so the URL cannot point anywhere else.
 */
function urlForApplicationDriver(validated: URL, database: string): string {
  const url = new URL(validated.toString())
  url.pathname = `/${database}`
  url.search = ''
  url.searchParams.set('sslmode', 'require')
  url.searchParams.set('connect_timeout', String(CONNECT_TIMEOUT_SECONDS))
  return url.toString()
}

/**
 * The database package's own migration verifier, run as a child process against
 * one database. It is the mechanism that refuses a target whose ledger is not
 * the migration chain's, so the proof uses the real one rather than a copy of
 * its rules. It reads the migration files from the repository and never touches
 * anything but the database it is given.
 */
async function runMigrationVerifier(database: string) {
  if (!existsSync(migrationFolder)) {
    throw new Error(`the migration folder ${migrationFolder} is missing`)
  }
  const result = await runBounded(
    ['bun', '--no-env-file', 'run', '--cwd', join(repositoryRoot, 'packages/db'), 'db:verify'],
    TOOL_TIMEOUT_MS,
    {
      ...toolEnvironment(),
      DATABASE_MIGRATION_URL: urlForApplicationDriver(target!, database),
    }
  )
  if (result.timedOut) {
    throw new Error(`the migration verifier exceeded ${TOOL_TIMEOUT_MS} ms and was killed`)
  }
  return { code: result.code, stderr: result.stderr, stdout: result.stdout }
}

/**
 * The application schema as one document: every table with its exact row count,
 * every column, the seeded tables' rows, the migration ledger and every schema
 * object the application schema owns. One statement per side, so the comparison
 * cannot be spread over a per-table loop that a restored schema could outgrow.
 *
 * The columns are compared in their physical order but without their ordinal
 * numbers: PostgreSQL's `information_schema.columns.ordinal_position` is the
 * column's attribute number, and an attribute number counts the columns a
 * migration dropped. A restored schema has no dropped columns, so the numbers
 * differ while the columns and their order do not. The order is the schema
 * property; the number is an artefact of the table's history.
 *
 * The objects are compared by their definitions, which is what a restore has to
 * reproduce: the index definition, the constraint definition, the function
 * definition, the trigger definition and the sequence's parameters. The
 * definitions are read from the catalog, so they name the schema they live in
 * and a restored definition and a source definition are the same text. The
 * order inside each class is by content, never by a catalog identifier, because
 * an identifier is a creation order and a restore creates the objects in the
 * dump's order, not in the source's.
 *
 * A sequence's current value is data rather than a definition and is not
 * compared: a restored sequence carries the value the dump recorded, and that
 * value is not a property of the schema.
 */
const APPLICATION_DOCUMENT_SQL = `
SELECT jsonb_build_object(
  'tables', (
    SELECT jsonb_agg(
      jsonb_build_object(
        'name', c.relname,
        'rows', (xpath('/row/count/text()', query_to_xml(
          format('SELECT count(*) AS count FROM %I.%I', n.nspname, c.relname), false, true, ''
        )))[1]::text::bigint
      ) ORDER BY c.relname
    )
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'r'
  ),
  'columns', (
    SELECT jsonb_agg(jsonb_build_array(
      c.table_name, c.column_name, c.data_type, c.is_nullable
    ) ORDER BY c.table_name, c.ordinal_position)
    FROM information_schema.columns c WHERE c.table_schema = $1
  ),
  'indexes', (
    SELECT jsonb_agg(jsonb_build_array(
      c.relname, i.indisunique, i.indisprimary, (i.indpred IS NOT NULL),
      pg_get_indexdef(i.indexrelid)
    ) ORDER BY c.relname, pg_get_indexdef(i.indexrelid))
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
  ),
  'constraints', (
    SELECT jsonb_agg(jsonb_build_array(
      c.relname, con.conname, con.contype,
      CASE WHEN con.contype IN ('c', 'f', 'p', 'u', 'x')
        THEN pg_get_constraintdef(con.oid) ELSE '' END
    ) ORDER BY c.relname, con.conname, con.contype)
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
  ),
  'functions', (
    SELECT jsonb_agg(jsonb_build_array(
      p.proname, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid)
    ) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1
  ),
  'triggers', (
    SELECT jsonb_agg(jsonb_build_array(
      c.relname, t.tgname, pg_get_triggerdef(t.oid)
    ) ORDER BY c.relname, t.tgname, pg_get_triggerdef(t.oid))
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND NOT t.tgisinternal
  ),
  'sequences', (
    SELECT jsonb_agg(jsonb_build_array(
      c.relname, s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle
    ) ORDER BY c.relname)
    FROM pg_sequence s
    JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
  ),
  'ledger', (
    SELECT jsonb_agg(jsonb_build_array(j.id, j.hash, j.created_at) ORDER BY j.id)
    FROM ${applicationLedger} j
  ),
  'users', (SELECT jsonb_agg(jsonb_build_array(u.id, u.display_name, u.is_temporary) ORDER BY u.id)
    FROM ${applicationSchema}.users u),
  'workspaces', (SELECT jsonb_agg(jsonb_build_array(w.id, w.name, w.owner_user_id, w.idempotency_key) ORDER BY w.id)
    FROM ${applicationSchema}.workspaces w)
) AS document`

async function applicationDocument(url: string): Promise<unknown> {
  const pool = poolFor(url)
  try {
    const result = await pool.query(APPLICATION_DOCUMENT_SQL, [applicationSchema])
    return result.rows[0]?.document ?? null
  } finally {
    await pool.end()
  }
}

/**
 * The two synthetic rows this run owns in the application schema: a user and
 * the workspace that names it. Both carry this run's own identifiers, so the
 * cleanup removes exactly what this run created and nothing else.
 */
async function seedApplicationRows(): Promise<void> {
  await admin!.query(
    `INSERT INTO ${applicationSchema}.users (id, display_name) VALUES ($1::uuid, $2)`,
    [seededUserId, `Restore Proof User ${suffix}`]
  )
  await admin!.query(
    `INSERT INTO ${applicationSchema}.workspaces (id, name, owner_user_id, idempotency_key)
     VALUES ($1::uuid, $2, $3::uuid, $4)`,
    [seededWorkspaceId, `Restore Proof Workspace ${suffix}`, seededUserId, seededIdempotencyKey]
  )
}

/**
 * Removes the seeded rows and proves they are gone. The workspace goes first,
 * because the user is its owner. The statement is idempotent, so a run whose
 * seeding failed part way still removes exactly what it created.
 */
async function removeSeededApplicationRows(): Promise<void> {
  await runOwnStatement(
    `DELETE FROM ${applicationSchema}.workspaces WHERE id = '${seededWorkspaceId}'::uuid`
  )
  await runOwnStatement(`DELETE FROM ${applicationSchema}.users WHERE id = '${seededUserId}'::uuid`)
  const remaining = await admin!.query(
    `SELECT (SELECT count(*)::int FROM ${applicationSchema}.users WHERE id = $1::uuid) AS users,
            (SELECT count(*)::int FROM ${applicationSchema}.workspaces WHERE id = $2::uuid) AS workspaces`,
    [seededUserId, seededWorkspaceId]
  )
  const row = remaining.rows[0] as { users: number; workspaces: number } | undefined
  if (!row || row.users !== 0 || row.workspaces !== 0) {
    throw new Error('the seeded application rows were not removed')
  }
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
    expect(options).toContain(`-c statement_timeout=${SERVER_STATEMENT_TIMEOUT_MS}`)
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

  test('the auth initializer is killed at its deadline when the server never answers', async () => {
    // A listener that accepts and never speaks: the initializer's own pool would wait
    // forever, so only the deadline on its process can end it.
    const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, open() {} } })
    try {
      const url = urlFor(loopbackTargetOf(`postgresql://u:p@127.0.0.1:${silent.port}/db`), 'db')
      const result = await runBounded([process.execPath, '--no-env-file', RUNNER], 1_500, {
        ...toolEnvironment(),
        ...environmentFor(url),
        AUTH_RUNNER_ACTION: 'plan',
      })
      expect(result.timedOut).toBe(true)
      expect(() => process.kill(result.pid, 0)).toThrow()
      expect(liveChildren.size).toBe(0)
    } finally {
      silent.stop(true)
    }
  }, 15_000)

  test('the bounded budgets fit inside the outer command ceiling, with a margin', () => {
    // The disposable CLI kills the whole run at its ceiling, before cleanup can finish,
    // so every budget that can run in one file must fit under it. The body's budget
    // already covers the restored-behaviour test's steps, so they are not added here.
    const worstCase =
      BEFORE_ALL_BUDGET_MS +
      TEST_BUDGET_MS +
      BLOCKED_TEST_BUDGET_MS +
      AFTER_ALL_BUDGET_MS +
      UNCONDITIONAL_BUDGET_MS
    expect(worstCase).toBeLessThanOrEqual(OUTER_COMMAND_CEILING_MS - OUTER_MARGIN_MS)
  })

  test('the server bounds end a statement before the client deadline does', () => {
    expect(SERVER_LOCK_TIMEOUT_MS).toBeLessThan(SERVER_STATEMENT_TIMEOUT_MS)
    expect(SERVER_STATEMENT_TIMEOUT_MS).toBeLessThan(DB_QUERY_TIMEOUT_MS)
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
    admin = poolFor(adminUrl())
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE DATABASE "${restoredDatabase}"`)
    await seedApplicationRows()
  }, BEFORE_ALL_BUDGET_MS)

  afterAll(async () => {
    const steps: Array<readonly [string, () => Promise<unknown>]> = [
      ['reap live tool processes', reapLiveChildren],
      [
        'drop restored database',
        () => runOwnStatement(`DROP DATABASE IF EXISTS "${restoredDatabase}" WITH (FORCE)`),
      ],
      ['drop schema', () => runOwnStatement(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)],
      ['remove seeded application rows', removeSeededApplicationRows],
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
      const applied = await runInitializer('apply', sourceSearchPath)
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
      // The application schema rides in the same dump: the disposable lane migrated it into
      // this instance before this file ran, so one dump carries both schemas and one restore
      // lands both in the same per-run target.
      const dumpFile = join(workDirectory!, 'schema.dump')
      const dumped = await runTool([
        'pg_dump',
        '--format=custom',
        `--schema=${schema}`,
        `--schema=${applicationSchema}`,
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
      const planned = await runInitializer('plan', urlFor(validated, restoredDatabase, schema))
      expect(planned.applied).toBe(false)
      expect(planned.before).toEqual({ add: [], create: [] })
      const after = await snapshotOf(restoredConnection, schema)
      expect(after.counts).toEqual(source.counts)
      expect(await tablesIn(schema)).toEqual(expectedTables)
    },
    TEST_BUDGET_MS
  )

  test(
    'the restored target is accepted by the migration preflight, and keeps the fence immutable and one admission per target',
    async () => {
      const validated = target!
      const restoredConnection = urlFor(validated, restoredDatabase)

      // 1. The positive preflight: the restored target is one the database package
      //    itself accepts. The ledger the restore carried is the source's ledger, so
      //    the preflight passes, and the verifier's own rerun changes nothing.
      const verified = await runMigrationVerifier(restoredDatabase)
      expect(verified.code).toBe(0)
      expect(verified.stdout).toContain('Migration verification passed')
      expect(verified.stderr).not.toContain('Migration history preflight failed')

      // 2. The fixture this proof owns inside the restored target: one agent, one
      //    group channel, two messages and one admission that names a target
      //    context. Every identifier is this run's own, and the whole fixture is
      //    removed again below, so the restored target is left exactly as the
      //    restore made it and the source target is never written to at all.
      const agentId = crypto.randomUUID()
      const channelId = crypto.randomUUID()
      const messageId = crypto.randomUUID()
      const secondMessageId = crypto.randomUUID()
      const intentId = crypto.randomUUID()
      const secondIntentId = crypto.randomUUID()
      const targetTaskId = crypto.randomUUID()
      const targetSessionId = `restore-proof-session-${suffix}`
      const controlPlaneAgentId = `agt_${'0'.repeat(26)}`
      const pool = poolFor(restoredConnection)
      try {
        // The fixture is one statement: the parents and the admission it names are
        // written together, so the foreign keys resolve inside the statement.
        const inserted = await pool.query(
          `WITH inserted_agent AS (
             INSERT INTO ${applicationSchema}.agents
               (id, control_plane_agent_id, workspace_id, name, profile_id, profile_version)
             VALUES ($1::uuid, $2, $3::uuid, 'Restore Proof Agent', 'restore-proof-profile', '1.0.0')
           ), inserted_channel AS (
             INSERT INTO ${applicationSchema}.channels
               (id, workspace_id, kind, title, idempotency_key)
             VALUES ($4::uuid, $3::uuid, 'group', 'Restore Proof Channel',
                     'restore-proof-channel-' || $4::text)
           ), inserted_message AS (
             INSERT INTO ${applicationSchema}.messages
               (id, workspace_id, channel_id, sender_kind, sender_user_id, body_text,
                idempotency_key, create_payload_hash)
             VALUES ($5::uuid, $3::uuid, $4::uuid, 'user', $6::uuid, 'Restore proof message',
                     'restore-proof-message-' || $5::text, 'restore-proof-hash-' || $5::text),
                    ($7::uuid, $3::uuid, $4::uuid, 'user', $6::uuid, 'Restore proof second message',
                     'restore-proof-message-' || $7::text, 'restore-proof-hash-' || $7::text)
           ), inserted_intent AS (
             INSERT INTO ${applicationSchema}.lead_turn_intents (
               id, workspace_id, channel_id, message_id, actor_user_id, agent_id,
               control_plane_agent_id, profile_id, profile_version, profile_revision,
               channel_version, channel_visibility, audience, dispatch_key, state, reason_code,
               handoff_target_session_id, handoff_target_generation, handoff_target_task_id,
               handoff_target_attempt
             ) VALUES (
               $8::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $1::uuid,
               $2, 'restore-proof-profile', '1.0.0', 0,
               1, 'workspace', '[]'::jsonb, 'lead-turn:' || $8::text, 'blocked',
               'ADMISSION_SERVICE_UNAVAILABLE',
               $9, 1, $10::uuid, 1
             )
             RETURNING id
           )
           SELECT count(*)::int AS intents FROM inserted_intent`,
          [
            agentId,
            controlPlaneAgentId,
            seededWorkspaceId,
            channelId,
            messageId,
            seededUserId,
            secondMessageId,
            intentId,
            targetSessionId,
            targetTaskId,
          ]
        )
        expect(inserted.rows[0]?.intents).toBe(1)

        // 3. The fence is set the way the product sets it: one statement that writes
        //    the whole attribution at once. The restored target accepts it, so the
        //    guard it carries is the one the source schema has.
        const fenced = await pool.query(
          `UPDATE ${applicationSchema}.lead_turn_intents
           SET rollback_fenced_at = $1::timestamptz,
               rollback_fence_actor_kind = 'user',
               rollback_fence_actor_ref = $2::uuid::text,
               rollback_fence_reason = 'operator_intervention',
               rollback_fence_authority = '{"schemaVersion":"1"}'::jsonb
           WHERE id = $3::uuid`,
          [at, seededUserId, intentId]
        )
        expect(fenced.rowCount).toBe(1)

        // 4. The attribution is immutable: a second write is refused, and the refusal
        //    is the trigger's own (a check violation with the trigger's message), not
        //    a constraint's.
        const refusedChange = await pool
          .query(
            `UPDATE ${applicationSchema}.lead_turn_intents
             SET rollback_fence_reason = 'rollback_cohort'
             WHERE id = $1::uuid`,
            [intentId]
          )
          .then(
            () => null,
            (error: unknown) => error
          )
        expect(refusedChange).not.toBeNull()
        expect((refusedChange as { code?: string }).code).toBe('23514')
        expect((refusedChange as Error).message).toContain(
          'rollback fence attribution is immutable'
        )

        // 5. One admission per target context: a second admission for the same target
        //    is refused by the unique index, in the restored target.
        const refusedDuplicate = await pool
          .query(
            `INSERT INTO ${applicationSchema}.lead_turn_intents (
               id, workspace_id, channel_id, message_id, actor_user_id, agent_id,
               control_plane_agent_id, profile_id, profile_version, profile_revision,
               channel_version, channel_visibility, audience, dispatch_key, state, reason_code,
               handoff_target_session_id, handoff_target_generation, handoff_target_task_id,
               handoff_target_attempt
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
               $7, 'restore-proof-profile', '1.0.0', 0,
               1, 'workspace', '[]'::jsonb, 'lead-turn:' || $1::text, 'blocked',
               'ADMISSION_SERVICE_UNAVAILABLE',
               $8, 1, $9::uuid, 1
             )`,
            [
              secondIntentId,
              seededWorkspaceId,
              channelId,
              secondMessageId,
              seededUserId,
              agentId,
              controlPlaneAgentId,
              targetSessionId,
              targetTaskId,
            ]
          )
          .then(
            () => null,
            (error: unknown) => error
          )
        expect(refusedDuplicate).not.toBeNull()
        expect((refusedDuplicate as { code?: string }).code).toBe('23505')
        expect((refusedDuplicate as Error).message).toContain('lead_turn_intents_target_unique')

        // 6. The fixture is removed again, and the fence it carried is still the
        //    fence the refused write could not change.
        const removed = await pool.query(
          `WITH removed_intent AS (
             DELETE FROM ${applicationSchema}.lead_turn_intents WHERE id = $1::uuid
             RETURNING rollback_fenced_at, rollback_fence_actor_ref, rollback_fence_reason
           ), removed_messages AS (
             DELETE FROM ${applicationSchema}.messages WHERE id = ANY($2::uuid[])
           ), removed_channel AS (
             DELETE FROM ${applicationSchema}.channels WHERE id = $3::uuid
           ), removed_agent AS (
             DELETE FROM ${applicationSchema}.agents WHERE id = $4::uuid
           )
           SELECT rollback_fenced_at, rollback_fence_actor_ref, rollback_fence_reason
           FROM removed_intent`,
          [intentId, [messageId, secondMessageId], channelId, agentId]
        )
        expect(removed.rows).toHaveLength(1)
        expect(removed.rows[0]?.rollback_fenced_at).not.toBeNull()
        expect(removed.rows[0]?.rollback_fence_actor_ref).toBe(seededUserId)
        expect(removed.rows[0]?.rollback_fence_reason).toBe('operator_intervention')
      } finally {
        await pool.end()
      }
    },
    RESTORED_BEHAVIOUR_BUDGET_MS
  )

  test(
    'the application schema is restored with its tables, columns, rows, schema objects and migration ledger, and a wrong target is refused',
    async () => {
      const validated = target!
      const sourceConnection = urlFor(validated, validated.pathname.slice(1))
      const restoredConnection = urlFor(validated, restoredDatabase)

      // 1. The source application schema, as one document: every table with its exact row
      //    count, every column, the seeded rows, the schema objects and the migration
      //    ledger.
      const source = (await applicationDocument(sourceConnection)) as {
        columns?: unknown[]
        constraints?: unknown[]
        functions?: unknown[]
        indexes?: unknown[]
        ledger?: unknown[]
        sequences?: unknown[]
        tables?: unknown[]
        triggers?: unknown[]
        users?: unknown[]
        workspaces?: unknown[]
      } | null
      expect(source).not.toBeNull()
      expect(source!.tables?.length ?? 0).toBeGreaterThan(1)
      expect(source!.columns?.length ?? 0).toBeGreaterThan(0)
      // The ledger is the target identity the schema exposes, and it is not empty: a
      // restored schema with no ledger would compare equal to an empty one.
      expect(source!.ledger?.length ?? 0).toBeGreaterThan(0)
      // Every object class is compared, and every one of them is present in the
      // source: an empty class would compare equal to an empty one, and the schema
      // objects are what the comparison below is for. The fence's own trigger and
      // function are among them, and the identity columns' sequences are too.
      expect(source!.indexes?.length ?? 0).toBeGreaterThan(0)
      expect(source!.constraints?.length ?? 0).toBeGreaterThan(0)
      expect(source!.functions?.length ?? 0).toBeGreaterThan(0)
      expect(source!.triggers?.length ?? 0).toBeGreaterThan(0)
      expect(source!.sequences?.length ?? 0).toBeGreaterThan(0)
      expect(JSON.stringify(source!.triggers)).toContain(
        'lead_turn_intents_rollback_fence_immutable'
      )
      expect(JSON.stringify(source!.functions)).toContain(
        'lead_turn_intents_rollback_fence_immutable'
      )
      expect(JSON.stringify(source!.indexes)).toContain('lead_turn_intents_target_unique')
      // The seeded rows are in the source, so the row comparison below is not vacuous.
      expect(source!.users).toContainEqual([seededUserId, `Restore Proof User ${suffix}`, false])
      expect(source!.workspaces).toContainEqual([
        seededWorkspaceId,
        `Restore Proof Workspace ${suffix}`,
        seededUserId,
        seededIdempotencyKey,
      ])

      // 2. The restored application schema is the same document: the same tables with the
      //    same row counts, the same columns, the same seeded rows, the same schema
      //    objects and the same ledger.
      const restored = await applicationDocument(restoredConnection)
      expect(restored).toEqual(source)

      // 3. A target whose ledger was altered is refused by the database package's own
      //    migration-history preflight. The ledger is the identity the current schema
      //    exposes, so this is the existing rejection, not an invented contract.
      const tamperPool = poolFor(restoredConnection)
      try {
        await tamperPool.query(
          `UPDATE ${applicationLedger} SET hash = $1
           WHERE id = (SELECT min(id) FROM ${applicationLedger})`,
          ['tampered-target-identity']
        )
      } finally {
        await tamperPool.end()
      }
      const refused = await runMigrationVerifier(restoredDatabase)
      expect(refused.code).not.toBe(0)
      expect(refused.stderr).toContain('Migration history preflight failed')
    },
    TEST_BUDGET_MS
  )

  test(
    'a cleanup statement blocked by a held lock ends at its bound, and cleanup still finishes',
    async () => {
      const probe = `cleanup_probe_${suffix}`
      await admin!.query(`CREATE TABLE "${schema}"."${probe}" (id int)`)

      // Another session holds an exclusive lock on the probe table inside a transaction.
      const holder = poolFor(adminUrl())
      const held = await holder.connect()
      try {
        await held.query('BEGIN')
        await held.query(`LOCK TABLE "${schema}"."${probe}" IN ACCESS EXCLUSIVE MODE`)

        // The cleanup statement waits on that lock, and the lock_timeout bound ends it.
        const started = Date.now()
        const blocked = await runOwnStatement(`DROP TABLE "${schema}"."${probe}"`).then(
          () => 'dropped',
          (error: unknown) => (error instanceof Error ? error.message : 'unexpected')
        )
        expect(blocked).toContain('lock timeout')
        expect(Date.now() - started).toBeLessThan(DB_QUERY_TIMEOUT_MS * 3)

        // Once the holder releases, the same step succeeds, and the admin connection is still usable.
        await held.query('ROLLBACK')
      } finally {
        held.release()
        await holder.end()
      }
      await runOwnStatement(`DROP TABLE "${schema}"."${probe}"`)
      const remaining = await admin!.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [schema, probe]
      )
      expect(remaining.rows).toHaveLength(0)
    },
    BLOCKED_TEST_BUDGET_MS
  )
})
