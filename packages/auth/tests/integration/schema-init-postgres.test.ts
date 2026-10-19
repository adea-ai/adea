import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Pool } from 'pg'

import { getMigrations } from 'better-auth/db/migration'

import { createBetterAuthOptions } from '../../src/better-auth-options'
import { createUnconfiguredDelivery } from '../../src/delivery'
import {
  AuthSchemaInitError,
  SCHEMA_INIT_APPLICATION_NAME,
  applyAuthSchema,
  initializeAuthSchemaOn,
  planAuthSchema,
  readAuthSchemaInitConfig,
  type AuthMigrationPlanner,
} from '../../src/schema-init'

// Runs against a disposable loopback PostgreSQL only. It creates two temporary
// roles and per-test schemas, and drops all of them in cleanup.
const databaseUrl = process.env.AUTH_POSTGRES_TEST_URL
const origin = 'http://127.0.0.1:8787'
const secret = 'disposable-schema-init-integration-secret-long-enough'
const expectedTables = ['account', 'session', 'user', 'verification']

const suffix = crypto.randomUUID().replaceAll('-', '')
const ownerRole = `auth_init_owner_${suffix}`
const runtimeRole = `auth_init_runtime_${suffix}`
const ownerPassword = `owner${suffix}`
const runtimePassword = `runtime${suffix}`
const createdSchemas: string[] = []

let admin: Pool | undefined

function withCredentials(role: string, password: string, schema: string): string {
  const url = new URL(databaseUrl!)
  url.username = role
  url.password = password
  url.searchParams.set('options', `-c search_path=${schema}`)
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

async function createSchema(schema: string): Promise<void> {
  await admin!.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${ownerRole}"`)
  await admin!.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}"`)
  createdSchemas.push(schema)
}

async function tablesIn(schema: string): Promise<string[]> {
  const rows = await admin!.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
    [schema]
  )
  return rows.rows.map((row) => row.table_name)
}

async function auditBackendsSettle(): Promise<number> {
  // pool.end() resolves once the client has closed; the server may need a
  // moment to retire the backend, so poll briefly before asserting none remain.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await admin!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = $1`,
      [SCHEMA_INIT_APPLICATION_NAME]
    )
    if (rows.rows[0]?.count === 0) return 0
    await Bun.sleep(100)
  }
  return -1
}

// Counts the Better Auth table names across every schema, so a refused run can
// be shown to have written nothing anywhere, not only in the intended schema.
async function authTableCount(): Promise<number> {
  const rows = await admin!.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM information_schema.tables
     WHERE table_name = ANY($1::text[]) AND table_type = 'BASE TABLE'`,
    [expectedTables]
  )
  return rows.rows[0]?.count ?? 0
}

function searchPathUrl(role: string, password: string, rawSearchPath: string): string {
  const url = new URL(databaseUrl!)
  url.username = role
  url.password = password
  url.searchParams.set('options', `-c search_path=${rawSearchPath}`)
  return url.toString()
}

// The deferred index statements Better Auth runs after the tables and columns.
// Read from the compiled plan so the test blocks a real generated index name.
async function deferredIndexNames(schema: string, environment: Record<string, string>) {
  const config = readAuthSchemaInitConfig(environment)
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 })
  try {
    const migrations = await getMigrations({
      ...createBetterAuthOptions({
        config,
        database: pool,
        delivery: createUnconfiguredDelivery(),
      }),
      logger: { disabled: true },
    })
    const compiled = await migrations.compileMigrations()
    return [...compiled.matchAll(/create (?:unique )?index "([^"]+)"/gi)].map((match) => match[1]!)
  } finally {
    await pool.end()
  }
}

async function failureOf(run: Promise<unknown>): Promise<AuthSchemaInitError> {
  try {
    await run
  } catch (error) {
    if (error instanceof AuthSchemaInitError) return error
    throw error
  }
  throw new Error('expected the schema initializer to fail')
}

describe.skipIf(!databaseUrl)('explicit Better Auth schema initialization (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(databaseUrl!)
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname)) {
      throw new Error('AUTH_POSTGRES_TEST_URL must use a loopback host and a disposable database')
    }
    admin = new Pool({ connectionString: databaseUrl, max: 1 })
    await admin.query(`CREATE ROLE "${ownerRole}" LOGIN PASSWORD '${ownerPassword}'`)
    await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'`)
  }, 30_000)

  afterAll(async () => {
    if (!admin) return
    for (const schema of createdSchemas) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
    for (const role of [ownerRole, runtimeRole]) {
      await admin.query(`DROP OWNED BY "${role}"`)
      await admin.query(`DROP ROLE IF EXISTS "${role}"`)
    }
    await admin.end()
    admin = undefined
  }, 30_000)

  test('an empty schema plans four tables, applies once, and reports nothing pending afterwards', async () => {
    const schema = `auth_init_empty_${suffix}`
    await createSchema(schema)
    const environment = environmentFor(withCredentials(ownerRole, ownerPassword, schema))

    const plan = await planAuthSchema(environment)
    expect(plan.applied).toBe(false)
    expect(plan.after).toBeUndefined()
    expect(plan.before.create).toEqual(expectedTables)
    expect(await tablesIn(schema)).toEqual([])

    const applied = await applyAuthSchema(environment)
    expect(applied.applied).toBe(true)
    expect(applied.before.create).toEqual(expectedTables)
    expect(applied.after).toEqual({ add: [], create: [] })
    expect(await tablesIn(schema)).toEqual(expectedTables)
  }, 60_000)

  test('replaying apply against an initialized schema is a no-op', async () => {
    const schema = `auth_init_replay_${suffix}`
    await createSchema(schema)
    const environment = environmentFor(withCredentials(ownerRole, ownerPassword, schema))
    await applyAuthSchema(environment)
    const before = await tablesIn(schema)

    const replay = await applyAuthSchema(environment)
    expect(replay.applied).toBe(false)
    expect(replay.before).toEqual({ add: [], create: [] })
    expect(await tablesIn(schema)).toEqual(before)
  }, 60_000)

  test('the runtime role can plan but cannot create tables through the initializer or directly', async () => {
    const schema = `auth_init_denied_${suffix}`
    await createSchema(schema)
    const runtimeEnvironment = environmentFor(withCredentials(runtimeRole, runtimePassword, schema))

    const plan = await planAuthSchema(runtimeEnvironment)
    expect(plan.applied).toBe(false)
    expect(plan.before.create).toEqual(expectedTables)

    const failure = await failureOf(applyAuthSchema(runtimeEnvironment))
    expect(failure.stage).toBe('apply')
    expect(await tablesIn(schema)).toEqual([])

    const runtimePool = new Pool({
      connectionString: withCredentials(runtimeRole, runtimePassword, schema),
      max: 1,
    })
    try {
      const denied = await runtimePool
        .query(`CREATE TABLE "${schema}".runtime_probe (id integer)`)
        .catch((error: { code?: string }) => error)
      expect((denied as { code?: string }).code).toBe('42501')
    } finally {
      await runtimePool.end()
    }
    expect(await tablesIn(schema)).toEqual([])
  }, 60_000)

  test('a search_path that names no existing schema fails before any mutation', async () => {
    const missing = `auth_init_missing_${suffix}`
    const environment = environmentFor(withCredentials(ownerRole, ownerPassword, missing))

    const failure = await failureOf(applyAuthSchema(environment))
    expect(failure.stage).toBe('target')
    expect(failure.message).toBe(
      'AUTH_MIGRATION_DATABASE_URL search_path must name exactly one existing, unquoted schema'
    )
    const exists = await admin!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1`,
      [missing]
    )
    expect(exists.rows[0]?.count).toBe(0)
  }, 60_000)

  test('a remote migration URL without TLS is refused before any connection', async () => {
    const failure = await failureOf(
      applyAuthSchema({
        ...environmentFor(`postgresql://${ownerRole}:${ownerPassword}@db.example.test/adea`),
      })
    )
    expect(failure.stage).toBe('config')
    expect(failure.message).toContain('AUTH_MIGRATION_DATABASE_URL')
    expect(failure.message).not.toContain(ownerPassword)
  }, 30_000)

  test('a failing target redacts its password and leaves no initializer backend behind', async () => {
    const missingDatabase = new URL(databaseUrl!)
    missingDatabase.pathname = `/auth_init_absent_${suffix}`
    missingDatabase.username = ownerRole
    missingDatabase.password = ownerPassword
    const environment = environmentFor(missingDatabase.toString())

    const failure = await failureOf(planAuthSchema(environment))
    expect(failure.stage).toBe('connect')
    expect(failure.message).not.toContain(ownerPassword)
    expect(await auditBackendsSettle()).toBe(0)
  }, 30_000)

  test('a failure after connecting still releases the pool', async () => {
    const missing = `auth_init_cleanup_${suffix}`
    const failure = await failureOf(
      applyAuthSchema(environmentFor(withCredentials(ownerRole, ownerPassword, missing)))
    )
    expect(failure.stage).toBe('target')
    expect(await auditBackendsSettle()).toBe(0)
  }, 30_000)

  test.each([
    [
      'a missing schema listed before a real one',
      (real: string) => `auth_init_absent_${suffix},${real}`,
    ],
    ['a real schema followed by public', (real: string) => `${real},public`],
    ['the $user placeholder before a real schema', (real: string) => `"$user",${real}`],
    ['a quoted mixed-case schema name', (_real: string) => `"Quoted_${suffix}"`],
  ])(
    'an ambiguous search_path (%s) is refused with no table written anywhere',
    async (_label, pathFor) => {
      const real = `auth_init_ambig_${crypto.randomUUID().replaceAll('-', '')}`
      await createSchema(real)
      if (_label.startsWith('a quoted')) {
        await admin!.query(`CREATE SCHEMA "Quoted_${suffix}" AUTHORIZATION "${ownerRole}"`)
        createdSchemas.push(`Quoted_${suffix}`)
      }
      const before = await authTableCount()
      const environment = environmentFor(searchPathUrl(ownerRole, ownerPassword, pathFor(real)))

      const failure = await failureOf(applyAuthSchema(environment))
      expect(failure.stage).toBe('target')
      expect(await authTableCount()).toBe(before)
      expect(await tablesIn(real)).toEqual([])
    },
    60_000
  )

  test('apply that leaves pending work is reported as a failure, never as success', async () => {
    const schema = `auth_init_pending_${suffix}`
    await createSchema(schema)
    const config = readAuthSchemaInitConfig(
      environmentFor(withCredentials(ownerRole, ownerPassword, schema))
    )
    const pool = new Pool({ connectionString: config.databaseUrl, max: 1 })
    try {
      // A planner that still reports `user` as pending after apply models an
      // apply that returned without completing the schema.
      const pendingPlanner = (async () => ({
        compileMigrations: async () => 'SELECT 1',
        runMigrations: async () => undefined,
        toBeAdded: [],
        toBeCreated: [{ fields: {}, order: 1, table: 'user' }],
      })) as unknown as AuthMigrationPlanner
      const failure = await failureOf(initializeAuthSchemaOn(pool, config, true, pendingPlanner))
      expect(failure.stage).toBe('apply')
      expect(failure.message).toContain('pending work after apply')
    } finally {
      await pool.end()
    }
  }, 30_000)

  test('a failure during apply rolls the whole schema back, and a replay then completes it', async () => {
    const schema = `auth_init_atomic_${suffix}`
    await createSchema(schema)
    const environment = environmentFor(withCredentials(ownerRole, ownerPassword, schema))
    const [indexName] = await deferredIndexNames(schema, environment)
    expect(indexName).toBeDefined()
    // Injected mid-apply failure: a relation already holds the deferred index's
    // name, so Better Auth's final CREATE INDEX fails after its tables exist.
    await admin!.query(`CREATE TABLE "${schema}"."${indexName}" (blocker integer)`)

    const failure = await failureOf(applyAuthSchema(environment))
    expect(failure.stage).toBe('apply')
    expect(await tablesIn(schema)).toEqual([indexName])
    expect(await auditBackendsSettle()).toBe(0)

    await admin!.query(`DROP TABLE "${schema}"."${indexName}"`)
    const replay = await applyAuthSchema(environment)
    expect(replay.applied).toBe(true)
    expect(replay.after).toEqual({ add: [], create: [] })
    expect(await tablesIn(schema)).toEqual(expectedTables)
    const indexes = await admin!.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [schema]
    )
    expect(indexes.rows.map((row) => row.indexname)).toContain(indexName)
    expect(await auditBackendsSettle()).toBe(0)
  }, 60_000)

  test('the command writes nothing to stderr on success, and one JSON line on a refused target', async () => {
    const schema = `auth_init_quiet_${suffix}`
    await createSchema(schema)
    // A column of the wrong type makes Better Auth's inspection log a warning.
    await admin!.query(`CREATE TABLE "${schema}"."user" (id text PRIMARY KEY, email integer)`)
    // The owner role must see the table, or inspection never reaches the column.
    await admin!.query(`ALTER TABLE "${schema}"."user" OWNER TO "${ownerRole}"`)
    const packageRoot = new URL('../../', import.meta.url).pathname
    const run = async (migrationUrl: string) => {
      const child = Bun.spawn(['bun', '--no-env-file', 'src/schema-init-cli.ts'], {
        cwd: packageRoot,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ...environmentFor(migrationUrl),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      })
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code: await child.exited, stderr, stdout }
    }

    const planned = await run(withCredentials(ownerRole, ownerPassword, schema))
    expect(planned.code).toBe(0)
    expect(planned.stderr).toBe('')
    expect(JSON.parse(planned.stdout.trim()).status).toBe('ok')

    const refused = await run(
      withCredentials(ownerRole, ownerPassword, `auth_init_absent_${suffix}`)
    )
    expect(refused.code).toBe(1)
    expect(refused.stderr.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(refused.stderr.trim()).stage).toBe('target')
  }, 60_000)
})
