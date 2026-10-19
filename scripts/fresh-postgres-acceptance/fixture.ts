// Dedicated opt-in acceptance entry; not part of default test discovery.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url))
type PostgresFactory = typeof import('postgres').default
const loadedPostgres = dbRequire('postgres') as PostgresFactory | { default: PostgresFactory }
const postgres: PostgresFactory =
  typeof loadedPostgres === 'function' ? loadedPostgres : loadedPostgres.default
import { createBetterAuthService } from '../../packages/auth/src/server'
import { createRecordingAuthDelivery } from '../../packages/auth/src/delivery'
import { applyAuthSchema } from '../../packages/auth/src/schema-init'
import { runFreshAuthAcceptance } from './auth-lifecycle'
import {
  canonicalUrl,
  createCanonicalDatabase,
  MIGRATION_ROLE,
  RUNTIME_ROLE,
} from '../../packages/db/tests/fixtures/canonical-boundary'
import {
  cleanupScratchDatabase,
  throwScratchFailures,
} from '../../packages/db/tests/integration/migration-history-preflight-scratch'
import { assertProvisionedLoopback, fixtureEnvironment } from './policy.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const provisioner = assertProvisionedLoopback(process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL)
const name = 'fresh_acceptance_' + randomUUID().replaceAll('-', '')
const urlFor = (database: string) => {
  const url = new URL(provisioner)
  url.pathname = '/' + database
  return url.toString()
}
const admin = postgres(provisioner, { max: 1, onnotice: () => {} })
const runtimeUrl = canonicalUrl(provisioner, name, RUNTIME_ROLE)
const migrationUrl = canonicalUrl(provisioner, name, MIGRATION_ROLE)
const childEnvironment = {
  ...fixtureEnvironment(provisioner),
  DATABASE_URL: runtimeUrl,
  DATABASE_URL_UNPOOLED: runtimeUrl,
  DATABASE_MIGRATION_URL: migrationUrl,
}
let provider: ReturnType<typeof postgres> | undefined
let runtimeService: ReturnType<typeof createBetterAuthService> | undefined
let migrated: ReturnType<typeof postgres> | undefined
let bodyFailed = false
let bodyError: unknown
let migrationCount = 0
const cleanupErrors: unknown[] = []
const environment = (url: string) => ({
  AUTH_BASE_URL: 'https://fresh.example.test',
  AUTH_DATABASE_URL: url,
  AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
  AUTH_SECURE_COOKIES: 'true',
  AUTH_TRUSTED_ORIGINS: 'https://fresh.example.test',
  AUTH_SECRET: 'synthetic-fresh-schema-secret-at-least-thirty-two-characters',
})
function withProviderSchema(value: string) {
  const url = new URL(value)
  url.searchParams.set('options', '-c search_path=auth_acceptance')
  return url.toString()
}
async function child(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: childEnvironment,
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  })
  if (result.error || result.status !== 0)
    throw new Error('fresh-schema child phase failed: ' + command)
}
try {
  await createCanonicalDatabase(admin, urlFor, name)
  await child('node', ['scripts/database-health.mjs'])
  await child('bun', [
    '--no-env-file',
    '--conditions=react-server',
    'run',
    'packages/db/src/verify-migrations.ts',
  ])
  migrated = postgres(migrationUrl, { max: 1, onnotice: () => {} })
  const journal = JSON.parse(
    await readFile(new URL('../../packages/db/drizzle/meta/_journal.json', import.meta.url), 'utf8')
  )
  const ledger = await migrated`SELECT hash, created_at FROM app.__drizzle_migrations ORDER BY id`
  migrationCount = ledger.length
  assert.equal(migrationCount, journal.entries.length)
  assert.ok(migrationCount > 0)
  // App migrations may seed configuration; product identities/workspaces must be empty.
  for (const table of ['users', 'auth_identities', 'workspaces']) {
    const rows = await migrated`SELECT count(*)::int AS count FROM ${migrated('app.' + table)}`
    assert.equal(rows[0]?.count, 0, 'fresh product table not empty')
  }
  await migrated.unsafe('CREATE SCHEMA auth_acceptance AUTHORIZATION ' + MIGRATION_ROLE)
  await migrated.unsafe('GRANT USAGE ON SCHEMA auth_acceptance TO ' + RUNTIME_ROLE)
  const recorder = createRecordingAuthDelivery()
  // The operator command's code path: migration role only, apply once, then replay as a no-op.
  const schemaEnvironment = {
    ...environment(withProviderSchema(migrationUrl)),
    AUTH_MIGRATION_DATABASE_URL: withProviderSchema(migrationUrl),
  }
  const applied = await applyAuthSchema(schemaEnvironment)
  assert.equal(applied.applied, true)
  assert.deepEqual(applied.before.create, ['account', 'session', 'user', 'verification'])
  assert.deepEqual(applied.after, { add: [], create: [] })
  const repeated = await applyAuthSchema(schemaEnvironment)
  assert.equal(repeated.applied, false)
  assert.deepEqual(repeated.before, { add: [], create: [] })
  provider = postgres(withProviderSchema(runtimeUrl), { max: 1, onnotice: () => {} })
  const privileges =
    await provider`SELECT has_schema_privilege(current_user, 'auth_acceptance', 'CREATE') AS ddl`
  assert.equal(privileges[0]?.ddl, false)
  runtimeService = createBetterAuthService(
    environment(withProviderSchema(runtimeUrl)),
    recorder.delivery
  )
  await runFreshAuthAcceptance(runtimeService, recorder, provider)
} catch (error) {
  bodyFailed = true
  bodyError = error
} finally {
  for (const close of [
    () => runtimeService?.close(),
    () => provider?.end(),
    () => migrated?.end(),
    () => cleanupScratchDatabase(admin, name),
    () => admin.end(),
  ]) {
    try {
      await close()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
}
throwScratchFailures(bodyFailed, bodyError, cleanupErrors)
console.log(
  'FRESH_SCHEMA_ACCEPTANCE ' + JSON.stringify({ status: 'passed', migrations: migrationCount })
)
