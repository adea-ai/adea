import { describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'

import {
  AuthSchemaInitError,
  applyAuthSchema,
  initializeAuthSchemaOn,
  planAuthSchema,
  readAuthSchemaInitConfig,
  type AuthMigrationPlanner,
  type AuthSchemaInitStage,
} from '../../src/schema-init'

// Every database step here runs against an in-memory fake. Nothing connects,
// except the two loopback tests at the end, which target a closed port.
const base = {
  AUTH_BASE_URL: 'https://auth.example.test',
  AUTH_SECRET: 'unit-schema-apply-secret-at-least-thirty-two-characters',
  AUTH_TRUSTED_ORIGINS: 'https://app.example.test',
}
const migrationUrl = 'postgresql://auth_owner:owner-only@127.0.0.1:5432/adea'
const config = readAuthSchemaInitConfig({ ...base, AUTH_MIGRATION_DATABASE_URL: migrationUrl })

type Pending = { create: readonly string[]; add: readonly string[] }

function fakePool(
  options: {
    searchPath?: string
    schema?: string | null
    failStatement?: (sql: string) => Error | undefined
    rollbackFails?: boolean
    connectFails?: Error
    targetFails?: Error
  } = {}
) {
  const statements: string[] = []
  const released: Array<boolean | undefined> = []
  const client = {
    async query(sql: string) {
      statements.push(sql)
      const failure = options.failStatement?.(sql)
      if (failure) throw failure
      if (sql === 'ROLLBACK' && options.rollbackFails) throw new Error('rollback refused')
      return { rows: [] }
    },
    release(destroy?: boolean) {
      released.push(destroy)
    },
  }
  const pool = {
    async query(sql: string) {
      statements.push(sql)
      if (options.targetFails) throw options.targetFails
      return {
        rows: [
          {
            schema: options.schema === undefined ? 'app_auth' : options.schema,
            search_path: options.searchPath ?? 'app_auth',
          },
        ],
      }
    },
    async connect() {
      if (options.connectFails) throw options.connectFails
      return client
    },
  }
  return { pool: pool as unknown as Pool, statements, released }
}

// Returns the pending work for each successive inspection; the last state repeats.
function planner(states: readonly Pending[], compiled = 'CREATE TABLE "user" ("id" text);') {
  let call = 0
  const planning: AuthMigrationPlanner = (async () => {
    const state = states[Math.min(call, states.length - 1)]!
    call += 1
    return {
      toBeAdded: state.add.map((table) => ({ table })),
      toBeCreated: state.create.map((table) => ({ table })),
      async compileMigrations() {
        return compiled
      },
      async runMigrations() {},
    }
  }) as unknown as AuthMigrationPlanner
  return planning
}

const pendingUser: Pending = { create: ['user'], add: [] }
const nothingPending: Pending = { create: [], add: [] }

async function failureOf(run: () => Promise<unknown>): Promise<AuthSchemaInitError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AuthSchemaInitError) return error
    throw error
  }
  throw new Error('expected the schema step to fail')
}

function expectStage(error: AuthSchemaInitError, stage: AuthSchemaInitStage) {
  expect(error.stage).toBe(stage)
}

describe('target guard', () => {
  test('refuses a multi-entry search_path before inspecting or changing anything', async () => {
    const { pool, statements } = fakePool({ searchPath: 'app_auth, public' })
    const error = await failureOf(() =>
      initializeAuthSchemaOn(pool, config, true, planner([pendingUser]))
    )

    expectStage(error, 'target')
    expect(statements.some((sql) => sql.startsWith('BEGIN'))).toBe(false)
  })

  test('refuses a search_path that is a $user placeholder', async () => {
    const { pool } = fakePool({ searchPath: '$user', schema: 'postgres' })
    const error = await failureOf(() =>
      initializeAuthSchemaOn(pool, config, false, planner([pendingUser]))
    )

    expectStage(error, 'target')
  })

  test('refuses a quoted or upper-case schema name', async () => {
    const { pool } = fakePool({ searchPath: 'App_Auth', schema: 'App_Auth' })
    const error = await failureOf(() =>
      initializeAuthSchemaOn(pool, config, false, planner([pendingUser]))
    )

    expectStage(error, 'target')
  })

  test('refuses when the effective schema differs from the search_path entry', async () => {
    const { pool } = fakePool({ searchPath: 'app_auth', schema: 'public' })
    const error = await failureOf(() =>
      initializeAuthSchemaOn(pool, config, false, planner([pendingUser]))
    )

    expectStage(error, 'target')
  })

  test('reports a failed target query as a connect-stage error with the secret removed', async () => {
    const { pool } = fakePool({
      targetFails: new Error(`cannot reach ${migrationUrl} as owner-only`),
    })
    const error = await failureOf(() =>
      initializeAuthSchemaOn(pool, config, false, planner([pendingUser]))
    )

    expectStage(error, 'connect')
    expect(error.message).not.toContain('owner-only')
    expect(error.message).toContain('[redacted]')
  })
})

describe('plan and apply decisions', () => {
  test('a plan reports pending tables and changes nothing', async () => {
    const { pool, statements } = fakePool()
    const result = await initializeAuthSchemaOn(pool, config, false, planner([pendingUser]))

    expect(result).toEqual({ applied: false, before: { add: [], create: ['user'] } })
    expect(statements.some((sql) => sql.startsWith('BEGIN'))).toBe(false)
  })

  test('an apply with nothing pending is a no-op', async () => {
    const { pool, statements } = fakePool()
    const result = await initializeAuthSchemaOn(pool, config, true, planner([nothingPending]))

    expect(result).toEqual({ applied: false, before: { add: [], create: [] } })
    expect(statements.some((sql) => sql.startsWith('BEGIN'))).toBe(false)
  })

  test('an apply runs the compiled statements inside one transaction and reports the result', async () => {
    const { pool, statements, released } = fakePool()
    const result = await initializeAuthSchemaOn(
      pool,
      config,
      true,
      planner([pendingUser, nothingPending])
    )

    expect(result.applied).toBe(true)
    expect(result.before).toEqual({ add: [], create: ['user'] })
    expect(result.after).toEqual({ add: [], create: [] })
    const transaction = statements.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK|CREATE)/.test(sql))
    expect(transaction).toEqual(['BEGIN', 'CREATE TABLE "user" ("id" text);', 'COMMIT'])
    expect(released).toEqual([undefined])
  })

  test('an apply that leaves work pending fails at the apply stage, not as success', async () => {
    const { pool } = fakePool()
    const error = await failureOf(() =>
      initializeAuthSchemaOn(pool, config, true, planner([pendingUser, pendingUser]))
    )

    expectStage(error, 'apply')
    expect(error.message).toContain('still has pending work')
  })

  test('compiled statements with bound parameters are refused before any change', async () => {
    const { pool, statements } = fakePool()
    const error = await failureOf(() =>
      initializeAuthSchemaOn(
        pool,
        config,
        true,
        planner([pendingUser], 'INSERT INTO x VALUES ($1)')
      )
    )

    expectStage(error, 'apply')
    expect(error.message).toContain('bound parameters')
    expect(statements.some((sql) => sql.startsWith('BEGIN'))).toBe(false)
  })
})

describe('transaction failure handling', () => {
  test('a failing statement rolls back and releases the connection normally', async () => {
    const { pool, statements, released } = fakePool({
      failStatement: (sql) =>
        sql.startsWith('CREATE TABLE') ? new Error('syntax boom') : undefined,
    })
    const error = await failureOf(() =>
      initializeAuthSchemaOn(pool, config, true, planner([pendingUser]))
    )

    expectStage(error, 'apply')
    expect(error.message).toContain('syntax boom')
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(released).toEqual([undefined])
  })

  test('a failing COMMIT rolls back the transaction', async () => {
    const { pool, statements } = fakePool({
      failStatement: (sql) => (sql === 'COMMIT' ? new Error('commit refused') : undefined),
    })
    const error = await failureOf(() =>
      initializeAuthSchemaOn(pool, config, true, planner([pendingUser]))
    )

    expectStage(error, 'apply')
    expect(statements.slice(-2)).toEqual(['COMMIT', 'ROLLBACK'])
  })

  test('a failed rollback destroys the connection instead of returning it to the pool', async () => {
    const { pool, released } = fakePool({
      failStatement: (sql) => (sql.startsWith('CREATE TABLE') ? new Error('boom') : undefined),
      rollbackFails: true,
    })
    await failureOf(() => initializeAuthSchemaOn(pool, config, true, planner([pendingUser])))

    expect(released).toEqual([true])
  })

  test('an error from the database is redacted of the migration password', async () => {
    const { pool } = fakePool({
      failStatement: (sql) =>
        sql.startsWith('CREATE TABLE')
          ? new Error('auth failed for owner-only on the migration role')
          : undefined,
    })
    const error = await failureOf(() =>
      initializeAuthSchemaOn(pool, config, true, planner([pendingUser]))
    )

    expect(error.message).not.toContain('owner-only')
    expect(error.message).toContain('[redacted]')
  })

  test('a connection that cannot be checked out fails at the connect stage', async () => {
    const { pool } = fakePool({ connectFails: new Error('pool exhausted') })
    const error = await failureOf(() =>
      initializeAuthSchemaOn(pool, config, true, planner([pendingUser]))
    )

    expectStage(error, 'connect')
  })

  test('an inspection failure is reported at the inspect stage, with the password redacted', async () => {
    const { pool } = fakePool()
    const failing = (async () => {
      throw new Error('inspection could not read owner-only credentials')
    }) as unknown as AuthMigrationPlanner
    const error = await failureOf(() => initializeAuthSchemaOn(pool, config, false, failing))

    expectStage(error, 'inspect')
    expect(error.message).not.toContain('owner-only')
  })

  test('a non-Error inspection failure still produces a bounded message', async () => {
    const { pool } = fakePool()
    const failing = (async () => {
      throw 'plain string'
    }) as unknown as AuthMigrationPlanner
    const error = await failureOf(() => initializeAuthSchemaOn(pool, config, false, failing))

    expectStage(error, 'inspect')
    expect(error.message).toBe('unexpected non-error failure')
  })

  test('a compile failure is an inspect-stage error and leaves no transaction open', async () => {
    const { pool, statements } = fakePool()
    const failing = (async () => ({
      toBeAdded: [],
      toBeCreated: [{ table: 'user' }],
      async compileMigrations() {
        throw new Error('cannot compile')
      },
      async runMigrations() {},
    })) as unknown as AuthMigrationPlanner
    const error = await failureOf(() => initializeAuthSchemaOn(pool, config, true, failing))

    expectStage(error, 'inspect')
    expect(statements.some((sql) => sql.startsWith('BEGIN'))).toBe(false)
  })
})

describe('the public entry points', () => {
  // The database is a closed loopback port. The connection is refused at once, so
  // these exercise the real pool lifecycle without a server.
  const refused = readAuthSchemaInitConfig({
    ...base,
    AUTH_MIGRATION_DATABASE_URL:
      'postgresql://auth_owner:refused-only@127.0.0.1:1/adea?sslmode=disable',
  })
  const refusedEnvironment = {
    ...base,
    AUTH_MIGRATION_DATABASE_URL: refused.databaseUrl,
  }

  test('planAuthSchema reports a refused connection at the connect stage, without the password', async () => {
    const error = await failureOf(() => planAuthSchema(refusedEnvironment))

    expectStage(error, 'connect')
    expect(error.message).not.toContain('refused-only')
  })

  test('applyAuthSchema reports the same refused connection and does not apply anything', async () => {
    const error = await failureOf(() => applyAuthSchema(refusedEnvironment))

    expectStage(error, 'connect')
    expect(error.message).not.toContain('refused-only')
  })

  test('a missing migration URL fails before any pool is created', async () => {
    const error = await failureOf(() => planAuthSchema({ ...base }))

    expectStage(error, 'config')
  })
})
