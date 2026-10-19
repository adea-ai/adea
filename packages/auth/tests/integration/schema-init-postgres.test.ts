import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Pool } from 'pg'

import {
  AuthSchemaInitError,
  SCHEMA_INIT_APPLICATION_NAME,
  applyAuthSchema,
  planAuthSchema,
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
      'AUTH_MIGRATION_DATABASE_URL search_path does not name an existing schema'
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
})
