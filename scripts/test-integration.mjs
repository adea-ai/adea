import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { assertLocalTestTargets } from './test-target-guard.mjs'
import {
  captureCommand,
  composePostgresImage,
  runWithPullFallback,
  withComposeImage,
} from './docker-pull-backoff.mjs'
import {
  discoverIntegrationInventory,
  parseIntegrationShard,
  planIntegrationRun,
} from './integration-inventory.mjs'
import {
  captureProvisioningDatabaseUrlVariable,
  startCaptureProvisioning,
} from './capture-provisioning.mjs'

const root = resolve(import.meta.dirname, '..')

// An inherited DATABASE_URL must be a local or CI-created target before anything runs.
assertLocalTestTargets()
const localDatabaseEnvironment = {
  DATABASE_URL:
    'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_URL_UNPOOLED:
    'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_MIGRATION_URL:
    'postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55432/agent_hq?sslmode=disable',
}

// ADEA_INTEGRATION_SHARD=<index>/<total> runs one explicit slice of the package suites, so a lane
// can split them across independent databases. Unset runs everything, route flow included. The
// route flow belongs to shard 1 only. See integration-inventory.mjs for the inventory and the split.
const shard = parseIntegrationShard(process.env.ADEA_INTEGRATION_SHARD)
const plan = planIntegrationRun(discoverIntegrationInventory(root), shard)

// --plan prints this invocation's selection and exits before any build, Docker, or database work.
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify({ shard, ...plan }, null, 2))
  process.exit(0)
}

// The opt-in joined proof (apps/web/test/control-plane-joined) mounts one pinned control-plane
// checkout. It is not part of the default lanes: `--control-plane-joined` runs only that proof,
// on this lane's provisioning, and a missing checkout fails the run instead of skipping it.
const controlPlaneJoined = process.argv.includes('--control-plane-joined')
const controlPlaneJoinedDirectory = resolve(root, 'apps', 'web', 'test', 'control-plane-joined')
const controlPlaneSource = process.env.ADEA_CONTROL_PLANE_SOURCE
if (controlPlaneJoined && !controlPlaneSource) {
  throw new Error(
    'ADEA_CONTROL_PLANE_SOURCE must name a checkout of the pinned control-plane revision (apps/web/test/control-plane-joined/control-plane-source.json)'
  )
}

function run(command, args, environment, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const outcome = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`
    throw new Error(`${command} ${args.join(' ')} failed with ${outcome}`)
  }
}

// A bare `compose up` would fail the lane on the shared registry's anonymous pull limit, so the
// start goes through the same fallback and backoff as the E2E setup. Output is echoed once each
// attempt settles so a rate-limited attempt stays visible in the log.
async function composeUpPostgres() {
  const args = ['compose', 'up', '-d', '--wait', '--wait-timeout', '30', 'postgres']
  const result = await runWithPullFallback(
    async (image) => {
      const attempt = await captureCommand('docker', args, {
        cwd: root,
        env: withComposeImage(process.env, image),
        signal: startupAbort.signal,
        processGroup: true,
      })
      if (attempt.stdout) process.stdout.write(attempt.stdout)
      if (attempt.stderr) process.stderr.write(attempt.stderr)
      return attempt
    },
    composePostgresImage(root),
    {
      signal: startupAbort.signal,
      sleep: (milliseconds) => sleep(milliseconds, undefined, { signal: startupAbort.signal }),
    }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed with exit code ${result.status}`)
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

// The migration-snapshot capture proofs need a disposable PostgreSQL scratch database per run; the
// provisioning helper in capture-provisioning.mjs starts and always removes it.

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
const startupAbort = new AbortController()
let startingLocalPostgres = false
let interruptedSignal
let signalListeners = []
let startedLocalPostgres = false
let captureProvisioning = null
let primaryFailure

try {
  // The database producer consumes the package's compiled public envelope
  // entry. Integration also runs independently from the workspace build.
  run('bun', ['run', '--cwd', 'packages/remote-content', 'build'], process.env)
  run('bun', ['run', '--cwd', 'packages/types', 'build'], process.env)
  run('bun', ['run', '--cwd', 'packages/auth', 'build'], process.env)
  // API regression cases exercise the production server handler through the
  // compiled database entry, with the explicit server-only runtime condition.
  run('bun', ['run', '--cwd', 'packages/db', 'build'], process.env)
  if (!usesExplicitDatabase && !runningComposeServices().includes('postgres')) {
    // Acquire cleanup ownership before startup: a failed health wait may leave a container.
    startedLocalPostgres = true
    attachLocalPostgresCleanup()
    startingLocalPostgres = true
    try {
      await composeUpPostgres()
    } finally {
      startingLocalPostgres = false
    }
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
  // Test-only provisioning for the capture proofs, independent of DATABASE_URL
  // (see startCaptureProvisioning). Without docker the proofs skip cleanly;
  // with docker a failed provisioning fails the lane instead of silently
  // shrinking the coverage the capture file exists to prove.
  captureProvisioning = startCaptureProvisioning((handle) => {
    captureProvisioning = handle
  })
  if (captureProvisioning) {
    environment[captureProvisioningDatabaseUrlVariable] = captureProvisioning.databaseUrl
  } else {
    console.warn(
      `Docker is unavailable; ${captureProvisioningDatabaseUrlVariable} is not provisioned and the migration-snapshot capture proofs will skip`
    )
  }

  if (controlPlaneJoined) {
    // Run from the control-plane checkout so its sources compile under its own TypeScript
    // configuration (decorators); the Adea modules load by relative path from this directory.
    run(
      'bun',
      [
        'test',
        '--conditions=react-server',
        '--timeout',
        String(timeoutMs),
        controlPlaneJoinedDirectory,
      ],
      { ...environment, ADEA_CONTROL_PLANE_SOURCE: controlPlaneSource },
      controlPlaneSource
    )
  } else {
    run(
      'bun',
      [
        '--conditions=react-server',
        'test',
        '--timeout',
        String(timeoutMs),
        ...plan.packageFiles.map((file) => resolve(root, file)),
      ],
      environment
    )
    // The route flow imports the compiled @adea-ai/api-client entry (the package
    // suites above read their own src relatively; the database entry is already
    // built before provisioning), so it must be built on a clean checkout before
    // the route tests run. Like the builds above, this keeps integration
    // runnable independently from a workspace-wide `vp run` build.
    if (plan.routeFiles.length > 0) {
      run('bun', ['run', '--cwd', 'packages/api-client', 'build'], process.env)
      // Data consumers import packages/data/src, whose state dependency resolves
      // through its compiled package entry under the react-server condition.
      run('bun', ['run', '--cwd', 'packages/state', 'build'], process.env)
      // The apps/web route-flow tests run under the react-server export condition, which the runner
      // supplies: the route modules carry the `server-only` marker and cannot initialize under bun's
      // default conditions. The shared database environment and the same latency-sized ceiling apply.
      // These files install different `mock.module` route/auth seams, so per-file workers keep the
      // route contracts and their module registries from leaking into one another.
      // Route modules reach `.tsx` through `@adea-ai/data` and the workspace UI. Bun 1.4.3 compiles those as
      // automatic dev JSX, which solid-js cannot link (no `jsxDEV`), so this run loads the same Solid transform
      // the package `test` scripts pass with `--preload` (the root bunfig preload line is pinned by the target guard).
      run(
        'bun',
        [
          'test',
          '--parallel',
          '--conditions=react-server',
          '--preload',
          resolve(root, 'scripts', 'test-solid-transform.ts'),
          '--timeout',
          String(timeoutMs),
          ...plan.routeFiles.map((file) => resolve(root, file)),
        ],
        environment
      )
    }
  }
} catch (error) {
  primaryFailure = error
}

cleanupResources()
if (interruptedSignal) terminateOnSignal()
if (primaryFailure) throw primaryFailure

// Compose startup is asynchronous and may be interrupted after creating the service.
// Keep signal listeners through normal teardown so a signal queued during spawnSync
// still terminates the runner once the event loop resumes.
function attachLocalPostgresCleanup() {
  process.on('exit', (code) => {
    cleanupResources()
    if (code === 0 && primaryFailure) process.exitCode = 1
  })
  signalListeners = ['SIGINT', 'SIGTERM'].map((signal) => [
    signal,
    () => {
      interruptedSignal ??= signal
      startupAbort.abort(new Error(`integration runner interrupted by ${signal}`))
      // Await startup cancellation/reaping before stop: otherwise Compose could
      // create the service after teardown has already completed.
      if (startingLocalPostgres) return
      cleanupResources()
      terminateOnSignal()
    },
  ])
  for (const [signal, listener] of signalListeners) process.on(signal, listener)
}

function terminateOnSignal() {
  for (const [name, listener] of signalListeners) process.off(name, listener)
  process.kill(process.pid, interruptedSignal)
}

function cleanupResources() {
  if (startedLocalPostgres) {
    // Clear ownership before stopping so exit/signal teardown cannot stop it twice.
    startedLocalPostgres = false
    try {
      const result = spawnSync('docker', ['compose', 'stop', 'postgres'], {
        cwd: root,
        env: process.env,
        stdio: 'inherit',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      })
      if (result.error) throw result.error
      if (result.status !== 0) {
        throw new Error(
          `docker compose stop postgres failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.status}`}`
        )
      }
    } catch (error) {
      console.error(`docker compose stop postgres failed: ${error.message}`)
      primaryFailure ??= error
    }
  }
  if (captureProvisioning) {
    const handle = captureProvisioning
    captureProvisioning = null
    try {
      handle.stop()
    } catch (error) {
      console.error(`removing the capture provisioning container failed: ${error.message}`)
      primaryFailure ??= error
    }
  }
}
