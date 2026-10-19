import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'

import { createBetterAuthOptions } from './better-auth-options'
import { readBetterAuthConfig, type AuthEnvironment, type BetterAuthConfig } from './config'
import { createUnconfiguredDelivery } from './delivery'

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
    connectionString: config.databaseUrl,
    max: 1,
  })

  let result: AuthSchemaInitResult | undefined
  let bodyError: unknown
  try {
    result = await runAgainstPool(pool, config, apply, secrets)
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

async function runAgainstPool(
  pool: Pool,
  config: BetterAuthConfig,
  apply: boolean,
  secrets: readonly string[]
): Promise<AuthSchemaInitResult> {
  // Refuse a search_path that names no existing schema before Better Auth can
  // create anything: `current_schema()` is null when none of its entries exists.
  const target = await atStage('connect', secrets, () =>
    pool.query<{ schema: string | null }>('SELECT current_schema() AS schema')
  )
  if (!target.rows[0]?.schema) {
    throw new AuthSchemaInitError(
      'target',
      'AUTH_MIGRATION_DATABASE_URL search_path does not name an existing schema'
    )
  }

  const options = createBetterAuthOptions({
    config,
    database: pool,
    delivery: createUnconfiguredDelivery(),
  })
  const migrations = await atStage('inspect', secrets, () => getMigrations(options))
  const before = tablesOf(migrations)
  if (!apply || (before.create.length === 0 && before.add.length === 0)) {
    return { applied: false, before }
  }

  await atStage('apply', secrets, () => migrations.runMigrations())
  const after = tablesOf(await atStage('inspect', secrets, () => getMigrations(options)))
  return { after, applied: true, before }
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
