import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'

import { createBetterAuthOptions } from './better-auth-options'
import { readBetterAuthConfig, type AuthEnvironment, type BetterAuthConfig } from './config'
import { createUnconfiguredDelivery } from './delivery'
import { authDatabasePoolOptions } from './database-pool'

/**
 * Explicit, operator-run creation of the Better Auth tables (`user`, `session`,
 * `account`, `verification`) on a fresh PostgreSQL instance.
 *
 * Inputs are deliberately separate from the runtime service:
 *
 * - `AUTH_MIGRATION_DATABASE_URL` is the only database this module reads. It
 *   should carry the schema-owning migration role. `AUTH_DATABASE_URL`, the
 *   runtime role, is never consulted, so a runtime credential cannot be used
 *   to create tables by accident.
 * - The other `AUTH_*` values are validated with the same rules as the runtime
 *   service, so the tables are created from the same Better Auth options.
 *
 * Ordering: (1) create the target schema and roles with the operator's own
 * tooling; (2) `planAuthSchema` (read-only) to see what would change; (3)
 * `applyAuthSchema` with the migration role; (4) only then start the runtime
 * service with `AUTH_DATABASE_URL` set to the runtime role. Re-applying an
 * initialized schema is a no-op.
 *
 * Every database step runs on one pool that is always released. Errors name the
 * stage that failed and never carry the connection string or its password.
 */

export const SCHEMA_INIT_APPLICATION_NAME = 'adea-auth-schema-init'

export type AuthSchemaInitStage = 'config' | 'connect' | 'target' | 'inspect' | 'apply' | 'cleanup'

export class AuthSchemaInitError extends Error {
  readonly stage: AuthSchemaInitStage

  constructor(stage: AuthSchemaInitStage, message: string) {
    super(message)
    this.name = 'AuthSchemaInitError'
    this.stage = stage
  }
}

/** Tables Better Auth would create (`create`) or extend (`add`), sorted by name. */
export type AuthSchemaTables = Readonly<{
  add: readonly string[]
  create: readonly string[]
}>

export type AuthSchemaInitResult = Readonly<{
  /** True only when this call ran Better Auth's migrations. */
  applied: boolean
  /** The pending work found before any change. */
  before: AuthSchemaTables
  /** The pending work after apply; present only when `applied` is true. */
  after?: AuthSchemaTables
}>

/**
 * Validates the migration inputs through the runtime config reader, pointed at
 * the migration URL. Errors are rewritten to name the migration variable.
 */
export function readAuthSchemaInitConfig(
  environment: AuthEnvironment = process.env
): BetterAuthConfig {
  const migrationUrl = environment.AUTH_MIGRATION_DATABASE_URL
  if (!migrationUrl) {
    throw new AuthSchemaInitError('config', 'AUTH_MIGRATION_DATABASE_URL is required')
  }
  try {
    // Overwrites any runtime AUTH_DATABASE_URL: the migration URL is the only
    // database this module may reach.
    return readBetterAuthConfig({ ...environment, AUTH_DATABASE_URL: migrationUrl })
  } catch (error) {
    throw new AuthSchemaInitError(
      'config',
      messageOf(error).replaceAll('AUTH_DATABASE_URL', 'AUTH_MIGRATION_DATABASE_URL')
    )
  }
}

/** Read-only: reports pending table work and changes nothing. */
export function planAuthSchema(environment: AuthEnvironment = process.env) {
  return runSchemaInit(environment, false)
}

/** Runs Better Auth's migrations if, and only if, the schema has pending work. */
export function applyAuthSchema(environment: AuthEnvironment = process.env) {
  return runSchemaInit(environment, true)
}

async function runSchemaInit(
  environment: AuthEnvironment,
  apply: boolean
): Promise<AuthSchemaInitResult> {
  const config = readAuthSchemaInitConfig(environment)
  const secrets = redactionTargets(config.databaseUrl)
  const pool = new Pool({
    application_name: SCHEMA_INIT_APPLICATION_NAME,
    ...authDatabasePoolOptions(config.databaseUrl, 'migration'),
    max: 1,
  })

  let result: AuthSchemaInitResult | undefined
  let bodyError: unknown
  try {
    result = await runAgainstPool(pool, config, apply, secrets, getMigrations)
  } catch (error) {
    bodyError = error
  }

  try {
    await pool.end()
  } catch (error) {
    if (bodyError === undefined) {
      throw new AuthSchemaInitError('cleanup', redact(messageOf(error), secrets))
    }
  }
  if (bodyError !== undefined) throw bodyError
  return result as AuthSchemaInitResult
}

/** The inspection entry point; injectable so the post-apply guard has a direct test. */
export type AuthMigrationPlanner = typeof getMigrations

// An unquoted, lower-case identifier: the only form whose effective name is the
// same for Better Auth's textual reading of `search_path` and PostgreSQL's
// unqualified DDL resolution.
const PLAIN_SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * Runs the plan (and, when asked, the apply) on an open pool. Exported so the
 * tests can drive the guards directly; production callers use
 * {@link planAuthSchema} and {@link applyAuthSchema}.
 */
export async function initializeAuthSchemaOn(
  pool: Pool,
  config: BetterAuthConfig,
  apply: boolean,
  planner: AuthMigrationPlanner = getMigrations
): Promise<AuthSchemaInitResult> {
  return runAgainstPool(pool, config, apply, redactionTargets(config.databaseUrl), planner)
}

async function runAgainstPool(
  pool: Pool,
  config: BetterAuthConfig,
  apply: boolean,
  secrets: readonly string[],
  planner: AuthMigrationPlanner
): Promise<AuthSchemaInitResult> {
  // Better Auth inspects the first literal `search_path` entry, while unqualified
  // DDL lands in the first schema that exists. Those agree only when the path is a
  // single plain name that exists, so anything else is refused before any change.
  const target = await atStage('connect', secrets, () =>
    pool.query<{ schema: string | null; search_path: string }>(
      "SELECT current_setting('search_path') AS search_path, current_schema() AS schema"
    )
  )
  const entries = (target.rows[0]?.search_path ?? '').split(',').map((entry) => entry.trim())
  const schema = target.rows[0]?.schema ?? null
  if (entries.length !== 1 || !PLAIN_SCHEMA_NAME.test(entries[0] ?? '') || schema !== entries[0]) {
    throw new AuthSchemaInitError(
      'target',
      'AUTH_MIGRATION_DATABASE_URL search_path must name exactly one existing, unquoted schema'
    )
  }

  // Migration logging is disabled here only. Upstream warnings would otherwise
  // reach stderr beside the single JSON error line this command promises.
  const options = {
    ...createBetterAuthOptions({
      config,
      database: pool,
      delivery: createUnconfiguredDelivery(),
    }),
    logger: { disabled: true },
  }
  const migrations = await atStage('inspect', secrets, () => planner(options))
  const before = tablesOf(migrations)
  if (!apply || (before.create.length === 0 && before.add.length === 0)) {
    return { applied: false, before }
  }

  // Better Auth's own runMigrations executes table, column and deferred index
  // statements one by one, outside a transaction, so an interruption can leave
  // a schema that replay mistakes for complete. Apply the same compiled
  // statements as one transaction on a single connection instead.
  const statements = await atStage('inspect', secrets, () => migrations.compileMigrations())
  if (/\$\d/.test(statements)) {
    throw new AuthSchemaInitError(
      'apply',
      'compiled schema statements contain bound parameters; refusing to apply them'
    )
  }
  await applyInOneTransaction(pool, statements, secrets)
  const after = tablesOf(await atStage('inspect', secrets, () => planner(options)))
  // Success is reported only when the post-apply inspection is empty. Anything
  // still pending means the schema is not initialized, whatever apply returned.
  if (after.create.length > 0 || after.add.length > 0) {
    throw new AuthSchemaInitError(
      'apply',
      'schema still has pending work after apply; initialization is not complete'
    )
  }
  return { after, applied: true, before }
}

/**
 * Runs the statements on one checked-out connection inside BEGIN/COMMIT, so a
 * failure at any point, including deferred indexes, leaves no partial schema.
 * The connection is released once; it is destroyed if rollback itself fails.
 */
async function applyInOneTransaction(
  pool: Pool,
  statements: string,
  secrets: readonly string[]
): Promise<void> {
  const client = await atStage('connect', secrets, () => pool.connect())
  let failure: unknown
  let rollbackFailed = false
  try {
    await atStage('apply', secrets, () => client.query('BEGIN'))
    await atStage('apply', secrets, () => client.query(statements))
    await atStage('apply', secrets, () => client.query('COMMIT'))
  } catch (error) {
    failure = error
    try {
      await client.query('ROLLBACK')
    } catch {
      rollbackFailed = true
    }
  } finally {
    client.release(rollbackFailed ? true : undefined)
  }
  if (failure !== undefined) throw failure
}

function tablesOf(migrations: {
  toBeAdded: ReadonlyArray<{ table: string }>
  toBeCreated: ReadonlyArray<{ table: string }>
}): AuthSchemaTables {
  return {
    add: migrations.toBeAdded.map(({ table }) => table).toSorted(),
    create: migrations.toBeCreated.map(({ table }) => table).toSorted(),
  }
}

async function atStage<T>(
  stage: AuthSchemaInitStage,
  secrets: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new AuthSchemaInitError(stage, redact(messageOf(error), secrets))
  }
}

/** The raw URL, its decoded and encoded password, and nothing else need hiding. */
function redactionTargets(databaseUrl: string): string[] {
  const targets = new Set<string>([databaseUrl])
  const parsed = new URL(databaseUrl)
  if (parsed.password) {
    targets.add(parsed.password)
    targets.add(decodeURIComponent(parsed.password))
  }
  return [...targets].filter((value) => value.length > 0)
}

function redact(message: string, secrets: readonly string[]): string {
  let redacted = message
  for (const secret of secrets) redacted = redacted.split(secret).join('[redacted]')
  return redacted
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected non-error failure'
}
