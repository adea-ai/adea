import { readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const localDatabaseEnvironment = {
  DATABASE_URL:
    'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_URL_UNPOOLED:
    'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_MIGRATION_URL:
    'postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55432/agent_hq?sslmode=disable',
}

const integrationDirectories = readdirSync(resolve(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(root, 'packages', entry.name, 'tests', 'integration'))
  .filter((directory) => existsSync(directory))
  .toSorted()

if (integrationDirectories.length === 0) {
  throw new Error('No package integration test directories were found')
}

// The apps/web route-flow tests (server route handlers against PostgreSQL)
// share this lane's provisioning but run under the react-server export
// condition, which the runner supplies — the route modules carry the
// `server-only` marker and cannot initialize under bun's default conditions.
// The directory is required to exist: coverage silently shrinking out of the
// lane would be indistinguishable from a green run.
const routeFlowDirectory = resolve(root, 'apps', 'web', 'test', 'integration')
if (!existsSync(routeFlowDirectory)) {
  throw new Error(
    'apps/web/test/integration is missing; the route-flow lane cannot be silently skipped'
  )
}
const routeFlowDirectories = [routeFlowDirectory]

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

function runningComposeServices() {
  const result = spawnSync('docker', ['compose', 'ps', '--status', 'running', '--services'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error('Docker is required when DATABASE_URL is not set')
  if (result.status !== 0) {
    throw new Error('Docker Compose is required when DATABASE_URL is not set')
  }
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

const usesExplicitDatabase = Boolean(process.env.DATABASE_URL)
if (usesExplicitDatabase) {
  const missingVariables = ['DATABASE_URL_UNPOOLED', 'DATABASE_MIGRATION_URL'].filter(
    (name) => !process.env[name]
  )
  if (missingVariables.length > 0) {
    throw new Error(
      `${missingVariables.join(', ')} ${missingVariables.length === 1 ? 'is' : 'are'} required when DATABASE_URL is supplied; use an isolated test target`
    )
  }
}

const environment = usesExplicitDatabase
  ? { ...process.env }
  : { ...process.env, ...localDatabaseEnvironment }
let startedLocalPostgres = false
let primaryFailure

try {
  // The database producer consumes the package's compiled public envelope
  // entry. Integration also runs independently from the workspace build.
  run('bun', ['run', '--cwd', 'packages/remote-content', 'build'], process.env)
  run('bun', ['run', '--cwd', 'packages/types', 'build'], process.env)
  run('bun', ['run', '--cwd', 'packages/auth', 'build'], process.env)
  if (!usesExplicitDatabase && !runningComposeServices().includes('postgres')) {
    run(
      'docker',
      ['compose', 'up', '-d', '--wait', '--wait-timeout', '30', 'postgres'],
      process.env
    )
    startedLocalPostgres = true
  }

  run('node', ['scripts/database-health.mjs'], environment)
  run('bun', ['run', '--cwd', 'packages/db', 'db:verify'], environment)
  // Remote Neon branches serve 50-150ms roundtrips (vs sub-millisecond local
  // Postgres) and the heavier integration cases issue hundreds of queries in
  // sequence. Measured: `read-state-search.test.ts` issues ~270 sequential
  // round-trips for a single test, so at the documented 50-150ms range that
  // one test legitimately needs 13.5s-40.6s. A single 30s ceiling therefore
  // failed the upper half of the very range this comment documents.
  //
  // So the ceiling follows the target: sub-millisecond loopback keeps the
  // fast signal that catches hung code, while an explicitly supplied remote
  // target gets a ceiling sized to its own latency. Both still terminate.
  const remoteTarget = usesExplicitDatabase
  const timeoutMs = remoteTarget
    ? Number(process.env.ADEA_INTEGRATION_TIMEOUT_MS ?? 120_000)
    : Number(process.env.ADEA_INTEGRATION_TIMEOUT_MS ?? 30_000)
  run('bun', ['test', '--timeout', String(timeoutMs), ...integrationDirectories], environment)
  // The route flow imports the compiled @adea-ai/db and @adea-ai/api-client
  // entries (the package suites above import their own src relatively), so
  // both must be built on a clean checkout before the route tests run. Like
  // the builds above, this keeps integration runnable independently from a
  // workspace-wide turbo build.
  run('bun', ['run', '--cwd', 'packages/db', 'build'], process.env)
  run('bun', ['run', '--cwd', 'packages/api-client', 'build'], process.env)
  // The runner sets the react-server condition for the route-flow modules;
  // the shared database environment and the same latency-sized ceiling apply.
  run(
    'bun',
    ['test', '--conditions=react-server', '--timeout', String(timeoutMs), ...routeFlowDirectories],
    environment
  )
} catch (error) {
  primaryFailure = error
}

if (startedLocalPostgres) {
  // Cleanup runs on success AND failure, and never hides the primary result:
  // when the lane already failed, a broken stop is reported to stderr instead
  // of replacing the real failure; when the lane was green, a leaked container
  // still fails the run.
  try {
    run('docker', ['compose', 'stop', 'postgres'], process.env)
  } catch (error) {
    console.error(`docker compose stop postgres failed: ${error.message}`)
    primaryFailure ??= error
  }
}

if (primaryFailure) throw primaryFailure
