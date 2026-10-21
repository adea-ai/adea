import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
import {
  CLEANUP_DECISION,
  CLEANUP_REFUSAL,
  DISK_PRESSURE,
  REUSABLE_PORT,
  RESOURCE_MODE,
  buildInventory,
  callerIdentity,
  claimResource,
  claimSharedResource,
  cleanupReceipt,
  currentOwner,
  deriveDisposablePort,
  diskPressureAdmission,
  leaseDirectory,
  listLeases,
  planCleanup,
  processIsAlive,
  reconcileLeases,
  releaseLease,
  releaseSharedResource,
  resolveResourceMode,
  resourceIdentity,
  runTokenFor,
  summariseReceipt,
} from './integration-resource-lease.mjs'
import { cleanupOwnedResources, runBounded } from './disposable-postgres-volume-cleanup.mjs'
import { proveSelfHostedAuthLifecycle } from './self-hosted-auth-lifecycle.ts'

const root = resolve(import.meta.dirname, '..')

/** Docker's answer when a network is not there. */
const ABSENT_NETWORK = /no such network|not found/iu

// An inherited DATABASE_URL must be a local or CI-created target before anything runs.
assertLocalTestTargets()
const usesExplicitDatabase = Boolean(process.env.DATABASE_URL)

// The lane's database instance is a leased resource, and the mode says how this
// run may use it. A disposable instance is labelled for this run alone and
// removed when the run ends. A reusable instance is shared with sequential runs
// under an exclusive claim, so two live runs never share a database. The lease
// is written before anything is created, so an interrupted run leaves evidence
// of what it owned instead of an unexplained resource.
const requestedMode = resolveResourceMode(process.env)
// The run's identity. A caller may name the run, and a named run keeps its
// project, its port and its database identity across a restart, so a restart
// recovers the recorded lease instead of minting a second, conflicting one.
const requestedRunId = process.env.ADEA_INTEGRATION_RUN_ID
const runToken = runTokenFor(requestedRunId)
const runId = requestedRunId ?? `run-${runToken}`
const leaseDirectoryPath = leaseDirectory(process.env)
const owner = currentOwner()

// The retention bound on the lane's own records. The records are evidence, and
// a bound is what keeps the evidence from growing without end.
const leaseRetentionMs = Number(process.env.ADEA_INTEGRATION_LEASE_RETENTION_MS ?? 604_800_000)

// The disk the lane's storage would live on. A run that cannot read it is
// refused, because an unknown disk is not a free disk.
const diskFloorBytes = Number(process.env.ADEA_INTEGRATION_DISK_FLOOR_BYTES ?? 536_870_912)
const diskRequiredBytes = Number(process.env.ADEA_INTEGRATION_DISK_REQUIRED_BYTES ?? 536_870_912)

// An explicit port is the operator's choice and is used as given. A derived one
// belongs to this run alone, so two concurrent runs never share a port.
const localPostgresPort =
  process.env.ADEA_POSTGRES_PORT ??
  (requestedMode === RESOURCE_MODE.reusable ? REUSABLE_PORT : deriveDisposablePort(runToken))
// Match Compose's configured host endpoint without allowing URL/host injection.
// Explicit targets do not consume the local Compose port.
if (
  !usesExplicitDatabase &&
  (!/^[1-9]\d{0,4}$/.test(localPostgresPort) || Number(localPostgresPort) > 65535)
) {
  throw new Error('ADEA_POSTGRES_PORT must be a decimal TCP port between 1 and 65535')
}

// The self-hosted auth lifecycle is proven against the instance this lane
// owns. The suite skips itself when this variable is absent, and a skipped
// suite is not a proof, so the runner supplies the variable to the run that
// proves the lifecycle.
//
// The variable is deliberately NOT part of the sweep's environment. The
// administrative URL below is a plain loopback connection, and the
// backup-and-restore suite that shares this variable requires a
// certificate-verified TLS connection with the instance's own pinned
// certificate, which a Compose instance does not have. The lifecycle suite
// needs no TLS; the sweep must not be handed a URL that another suite would
// refuse.

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

// The bytes the lane's storage would have to grow into.
//
// The lane creates a volume, so it asks the disk first. A run that cannot read
// the disk is refused: an unknown disk is not a free disk.
//
// Docker Desktop keeps its data inside a virtual machine, so the root it
// reports is not a path on this host. The home directory is on the same
// volume as that image, and the temporary directory is the last place the
// lane looks. If none of them can be read, the run is refused.
function availableDiskBytes() {
  const candidates = []
  const result = spawnSync('docker', ['info', '--format', '{{.DockerRootDir}}'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  if (result.status === 0) {
    const directory = result.stdout.trim()
    if (directory !== '') candidates.push(directory)
  }
  candidates.push(homedir())
  candidates.push(tmpdir())
  for (const candidate of candidates) {
    try {
      const stats = statfsSync(candidate)
      return stats.bavail * stats.bsize
    } catch {
      // The next candidate is tried.
    }
  }
  return null
}

// Reads the resources the lane can see, without changing any of them.
//
// The image is read because it is reused, never removed. The project's own
// resources are read because they are the ones this run may remove. The
// volumes that carry no project label are read because they are the ones the
// lane must never touch: a volume that is merely unattached is not evidence of
// ownership, and it is never safe to delete.
function inspectDockerResources(identity) {
  const resources = []
  const image = composePostgresImage(root)
  const inspected = runBounded('docker', ['image', 'inspect', image], {
    spawnSync,
    timeoutMs: 30_000,
  })
  resources.push({ kind: 'image', name: image, label: null, present: inspected.status === 0 })
  if (!identity.project) return resources

  const listed = (args) => {
    const result = spawnSync('docker', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    if (result.status !== 0) return []
    return result.stdout.split(/\r?\n/).filter(Boolean)
  }
  for (const [kind, args] of [
    [
      'container',
      [
        'ps',
        '-a',
        '--filter',
        `label=com.docker.compose.project=${identity.project}`,
        '--format',
        '{{.Names}}',
      ],
    ],
    [
      'volume',
      [
        'volume',
        'ls',
        '--filter',
        `label=com.docker.compose.project=${identity.project}`,
        '--format',
        '{{.Name}}',
      ],
    ],
    [
      'network',
      [
        'network',
        'ls',
        '--filter',
        `label=com.docker.compose.project=${identity.project}`,
        '--format',
        '{{.Name}}',
      ],
    ],
  ]) {
    for (const name of listed(args)) {
      resources.push({ kind, name, label: identity.project, present: true })
    }
  }
  for (const name of listed([
    'volume',
    'ls',
    '--filter',
    'label!=com.docker.compose.project',
    '--format',
    '{{.Name}}',
  ])) {
    resources.push({ kind: 'volume', name, label: null, present: true, attached: false })
  }
  return resources
}

// The identity names the resources this run may use. A caller-supplied target
// is named by its endpoint and stays the caller's: the lane never removes a
// target it did not create.
const ownership = usesExplicitDatabase ? 'caller' : 'owned'
let identity = usesExplicitDatabase
  ? callerIdentity(process.env.DATABASE_URL)
  : resourceIdentity({ mode: requestedMode, runToken, port: localPostgresPort })

// --inventory reports what the lane can see and what it would do with each
// resource. It reads only: it creates nothing, claims nothing and removes
// nothing.
if (process.argv.includes('--inventory')) {
  console.log(
    JSON.stringify(
      buildInventory({
        resources: inspectDockerResources(identity),
        identity,
        leases: listLeases(leaseDirectoryPath),
      }),
      null,
      2
    )
  )
  process.exit(0)
}

// The lane is admitted before it claims anything and before it creates
// anything. A disk that is too full, or a disk that cannot be read, refuses
// the run rather than filling the machine.
if (ownership === 'owned') {
  const admission = diskPressureAdmission({
    availableBytes: availableDiskBytes(),
    requiredBytes: diskRequiredBytes,
    limitBytes: diskFloorBytes,
  })
  if (admission.decision === DISK_PRESSURE.refused) {
    throw new Error(`the integration lane was not admitted: ${admission.reason}`)
  }
}

// The claim is taken before the instance is started, so the ownership record
// exists before the resource does.
//
// The lease directory is reconciled first. The records that this run owns are
// taken back, the settled records that are older than the retention bound are
// pruned, and every other record is left alone: a record left by a dead run
// is evidence of a resource that still exists, and removing that resource is
// an operator's decision, not the lane's.
const reconciliation = reconcileLeases({
  directory: leaseDirectoryPath,
  runId,
  identity,
  retentionMs: leaseRetentionMs,
})
// The reconciliation is reported, so a reader can see what the lane found
// before it claimed anything.
console.log(
  `the integration lease reconciliation found ${reconciliation.found.length} record(s) and pruned ${reconciliation.pruned.length}`
)

// The liveness of an owner is read from the process table, not assumed. An
// owner on another host cannot be probed, and an unprobeable owner is treated
// as a live one, so a resource somebody else may still hold is never taken.
const ownerIsAlive = (pid, ownerHostname) => processIsAlive(pid, ownerHostname)

// The shared claim is one file per resource, created with an exclusive
// create. Two live runs cannot both hold it, so they cannot share a database
// even when they read the same empty directory at the same moment.
let sharedClaim = null
if (ownership === 'owned') {
  sharedClaim = claimSharedResource({
    directory: leaseDirectoryPath,
    resourceKey: identity.label,
    runId,
    identity,
    owner,
    isProcessAlive: ownerIsAlive,
  })
  if (
    sharedClaim.decision === 'refused' &&
    ownership === 'owned' &&
    requestedMode === RESOURCE_MODE.reusable &&
    (sharedClaim.reason === CLEANUP_REFUSAL.active ||
      sharedClaim.reason === CLEANUP_REFUSAL.unsafeArbitration)
  ) {
    // The shared instance is held by a live run, or two runs are contending for
    // it and the arbitration cannot be proved. A concurrent run does not share
    // a database with it: it takes an instance labelled for itself, and says so.
    identity = resourceIdentity({
      mode: RESOURCE_MODE.disposable,
      runToken,
      port: deriveDisposablePort(runToken),
    })
    sharedClaim = claimSharedResource({
      directory: leaseDirectoryPath,
      resourceKey: identity.label,
      runId,
      identity,
      owner,
      isProcessAlive: ownerIsAlive,
    })
  }
  if (sharedClaim.decision === 'refused') {
    throw new Error(`the integration resource is not available: ${sharedClaim.reason}`)
  }
}

// The lease is this run's own record of what it owns. The mode it records is
// the mode this run actually ended up in, which is not always the mode it
// asked for: a run that could not take the shared instance took one of its
// own, and the record has to say so.
let claim = claimResource({
  directory: leaseDirectoryPath,
  runId,
  mode: identity.mode,
  identity,
  owner,
  isProcessAlive: ownerIsAlive,
})
if (claim.decision === 'refused') {
  // The run's own record says something else, so the run owns nothing here.
  if (sharedClaim?.decision === 'granted') {
    releaseSharedResource({
      directory: leaseDirectoryPath,
      resourceKey: identity.label,
      runId,
      identity,
    })
  }
  throw new Error(`the integration resource is not available: ${claim.reason}`)
}
const lease = claim.lease

// The lane's own instance answers on the port its identity names.
const localDatabaseEnvironment = {
  DATABASE_URL: `postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:${identity.port}/agent_hq?sslmode=disable`,
  DATABASE_URL_UNPOOLED: `postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:${identity.port}/agent_hq?sslmode=disable`,
  DATABASE_MIGRATION_URL: `postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:${identity.port}/agent_hq?sslmode=disable`,
}
const localAuthDatabaseUrl = `postgresql://agent_hq_local_admin:agent_hq_local_admin@127.0.0.1:${identity.port}/agent_hq?sslmode=disable`

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
  lastChildOutcome = { status: result.status ?? null, signal: result.signal ?? null }
  if (result.error) throw result.error
  if (result.status !== 0) {
    const outcome = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`
    throw new Error(`${command} ${args.join(' ')} failed with ${outcome}`)
  }
}

// Every Compose call names the project this run owns. A run never drives a
// project it did not label, and never inherits a project name from the
// directory it happens to run in.
function composeArgs(...args) {
  return identity.project ? ['compose', '--project-name', identity.project, ...args] : args
}

// A bare `compose up` would fail the lane on the shared registry's anonymous pull limit, so the
// start goes through the same fallback and backoff as the E2E setup. Output is echoed once each
// attempt settles so a rate-limited attempt stays visible in the log.
async function composeUpPostgres() {
  const args = composeArgs('up', '-d', '--wait', '--wait-timeout', '30', 'postgres')
  const result = await runWithPullFallback(
    async (image) => {
      const attempt = await captureCommand('docker', args, {
        cwd: root,
        env: withComposeImage({ ...process.env, ADEA_POSTGRES_PORT: identity.port }, image),
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
  const result = spawnSync('docker', composeArgs('ps', '--status', 'running', '--services'), {
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
assertLocalTestTargets(environment)
const startupAbort = new AbortController()
let startingLocalPostgres = false
let interruptedSignal
let signalListeners = []
let startedLocalPostgres = false
let captureProvisioning = null
let primaryFailure
let lastChildOutcome = null
let cleanupSettled = false

try {
  // The database producer consumes the package's compiled public envelope
  // entry. Integration also runs independently from the workspace build.
  run('bun', ['run', '--cwd', 'packages/remote-content', 'build'], process.env)
  run('bun', ['run', '--cwd', 'packages/types', 'build'], process.env)
  run('bun', ['run', '--cwd', 'packages/auth', 'build'], process.env)
  // The joined Sim acceptance imports the hosted service's server modules, and those import the
  // compiled Sim bridge. The spatial package's export map names its compiled entry, so a clean
  // checkout has to build the spatial package before the suites run or the import cannot resolve
  // and the joined acceptance never runs. Like the builds above, this keeps integration runnable
  // independently from a workspace-wide `vp run` build.
  run('bun', ['run', '--cwd', 'packages/spatial', 'build'], process.env)
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
  // A remote database serves 50-150ms roundtrips (vs sub-millisecond local
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
  // The self-hosted auth lifecycle is proven here, against the real instance
  // this lane owns: the suite signs a user up, reads the session back, revokes
  // it and proves the persisted session is gone. The suite skips itself when
  // the variable is absent, so a run that skipped is refused rather than
  // reported as a pass.
  //
  // An explicit target owns no loopback instance, so the lifecycle is not
  // proven there. That is stated rather than hidden: this lane did not prove
  // the lifecycle, and it does not claim it.
  if (usesExplicitDatabase) {
    console.warn(
      'the self-hosted auth lifecycle was not proven: this run uses an explicit target and owns no loopback instance'
    )
  } else {
    proveSelfHostedAuthLifecycle(
      (name, args, commandEnvironment) => {
        const result = spawnSync(name, [...args], {
          cwd: root,
          encoding: 'utf8',
          env: commandEnvironment,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: Math.max(timeoutMs, 120_000),
        })
        if (result.error) throw result.error
        return {
          status: result.status ?? 1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        }
      },
      { databaseUrl: localAuthDatabaseUrl }
    )
    console.log('the self-hosted auth lifecycle was proven against the local instance')
  }
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
      applyCleanupPlan(
        planCleanup({
          lease,
          expectedIdentity: identity,
          ownership,
          startedByThisRun: true,
          ownerPid: process.pid,
          retainedPaths: [root],
        })
      )
    } catch (error) {
      console.error(`the integration resource cleanup failed: ${error.message}`)
      primaryFailure ??= error
    }
  } else if (!cleanupSettled) {
    // This run started nothing, so there is nothing of its own to remove. The
    // receipt still says so, because a run that kept a resource has to record
    // that it kept it.
    try {
      applyCleanupPlan(
        planCleanup({
          lease,
          expectedIdentity: identity,
          ownership,
          startedByThisRun: false,
          ownerPid: process.pid,
          retainedPaths: [root],
        })
      )
    } catch (error) {
      console.error(`the integration resource cleanup failed: ${error.message}`)
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

// Reads the Compose project a resource belongs to.
//
// A name is not an ownership proof. Compose labels every resource it creates
// with the project it created it for, so the label is what says whether a
// container or a volume is this run's. A resource whose label cannot be read
// is not owned either: an unreadable label is an unknown owner, and an unknown
// owner is never removed.
function composeProjectOf(kind, name) {
  const label = '{{index .Labels "com.docker.compose.project"}}'
  const args =
    kind === 'container'
      ? ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', name]
      : kind === 'network'
        ? ['network', 'inspect', '--format', label, name]
        : ['volume', 'inspect', '--format', label, name]
  const result = runBounded('docker', args, { spawnSync, timeoutMs: 30_000 })
  if (result.status !== 0) return null
  const project = result.stdout.trim()
  return project === '' ? null : project
}

// Applies a cleanup plan and records what actually happened.
//
// The receipt separates the child's exit from the resources' fate: a suite
// that failed is not a failed cleanup, a resource that was retained is not a
// removed one, and a removal that could not be confirmed never counts as
// absent.
function applyCleanupPlan(cleanupPlan) {
  const errors = []
  let resources = cleanupPlan.resources

  if (
    cleanupPlan.decision === CLEANUP_DECISION.stop ||
    cleanupPlan.decision === CLEANUP_DECISION.retain
  ) {
    resources = resources.map((resource) => {
      if (resource.action !== 'stopped') return resource
      const result = spawnSync('docker', composeArgs('stop', 'postgres'), {
        cwd: root,
        env: { ...process.env, ADEA_POSTGRES_PORT: identity.port },
        stdio: 'inherit',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      })
      if (result.error) {
        errors.push(`stopping the owned container failed: ${result.error.message}`)
        return { ...resource, verifiedAbsent: null }
      }
      if (result.status !== 0) {
        const outcome = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`
        errors.push(`stopping the owned container failed with ${outcome}`)
        return { ...resource, verifiedAbsent: null }
      }
      // A stopped container is still there. The receipt says it was stopped,
      // not that it is gone.
      return { ...resource, verifiedAbsent: false }
    })
  }

  if (cleanupPlan.decision === CLEANUP_DECISION.remove) {
    // Only Docker objects carry a project label. The database and the isolated
    // test data inside it travel with the volume, so they are removed with it
    // and are never looked for on their own.
    const dockerKinds = ['container', 'volume', 'network']
    const removable = resources.filter(
      (resource) => resource.action === 'removed' && dockerKinds.includes(resource.kind)
    )
    const foreign = []
    for (const candidate of removable) {
      const project = composeProjectOf(candidate.kind, candidate.name)
      if (project !== identity.project) {
        foreign.push(candidate)
        errors.push(
          `the ${candidate.kind} ${candidate.name} does not carry this run's project label, so it was not removed`
        )
      }
    }
    const owned = removable.filter((resource) => !foreign.includes(resource))
    const removal = cleanupOwnedResources({
      containers: owned.filter((resource) => resource.kind === 'container').map((r) => r.name),
      volumes: owned.filter((resource) => resource.kind === 'volume').map((r) => r.name),
      removeContainer: (name) => ['rm', '--force', name],
      run: (args) => runBounded('docker', args, { spawnSync, timeoutMs: 60_000 }),
    })
    for (const error of removal.errors) errors.push(error)

    // The network holds the container's endpoint, so it is removed after the
    // container, and its absence is confirmed rather than assumed.
    const networkRemoved = new Set()
    if (owned.some((resource) => resource.kind === 'network')) {
      const networkRemoval = runBounded('docker', ['network', 'rm', identity.network], {
        spawnSync,
        timeoutMs: 60_000,
      })
      if (networkRemoval.timedOut) {
        errors.push(`removing the owned network timed out`)
      } else if (networkRemoval.status !== 0) {
        errors.push(`removing the owned network failed with exit code ${networkRemoval.status}`)
      } else {
        const absent = runBounded('docker', ['network', 'inspect', identity.network], {
          spawnSync,
          timeoutMs: 30_000,
        })
        // Only a confirmed not-found is an absence. A timeout, a refused call
        // or a daemon that cannot answer leaves the state unknown, and an
        // unknown state is never a confirmed removal.
        if (absent.status === 0) {
          errors.push(`the owned network is still present: ${identity.network}`)
        } else if (ABSENT_NETWORK.test(absent.stderr ?? '')) {
          networkRemoved.add(identity.network)
        } else {
          errors.push(
            `the absence of the owned network could not be confirmed: ${identity.network}`
          )
        }
      }
    }

    resources = resources.map((resource) => {
      if (resource.action !== 'removed') return resource
      if (foreign.includes(resource)) {
        return { ...resource, action: 'refused', reason: 'foreign', verifiedAbsent: null }
      }
      if (resource.kind === 'network') {
        return networkRemoved.has(resource.name)
          ? { ...resource, verifiedAbsent: true }
          : {
              ...resource,
              action: 'unknown',
              reason: 'the absence could not be confirmed',
              verifiedAbsent: null,
            }
      }
      if (resource.kind === 'container' || resource.kind === 'volume') {
        // A removal that was attempted is not a removal that happened: the
        // receipt only says removed when the absence was confirmed.
        return removal.remaining.includes(resource.name)
          ? {
              ...resource,
              action: 'unknown',
              reason: 'the absence could not be confirmed',
              verifiedAbsent: null,
            }
          : { ...resource, verifiedAbsent: true }
      }
      // The database and the isolated test data live in the volume. When the
      // volume was refused, they were not removed either, and the receipt
      // says so rather than claiming a removal that did not happen.
      if (foreign.some((refused) => refused.kind === 'volume')) {
        return { ...resource, action: 'refused', reason: 'foreign', verifiedAbsent: null }
      }
      return removal.remaining.includes(identity.volume)
        ? {
            ...resource,
            action: 'unknown',
            reason: 'the absence could not be confirmed',
            verifiedAbsent: null,
          }
        : { ...resource, verifiedAbsent: true }
    })
  }

  // The shared claim is released with the cleanup, so the next sequential run
  // can take the instance it was using. A claim that cannot be released is
  // reported: the next run will find an owner that is gone and will say so.
  if (sharedClaim?.decision === 'granted') {
    const released = releaseSharedResource({
      directory: leaseDirectoryPath,
      resourceKey: identity.label,
      runId,
      identity,
    })
    if (!released.released) {
      errors.push(`the shared claim was not released: ${released.reason}`)
    }
  }

  const receipt = cleanupReceipt({
    lease,
    decision: cleanupPlan.decision,
    reason: cleanupPlan.reason,
    resources,
    child: lastChildOutcome,
    errors,
  })
  releaseLease({ directory: leaseDirectoryPath, runId, receipt })
  cleanupSettled = true
  console.log(`the integration resource receipt: ${summariseReceipt(receipt)}`)
  if (errors.length > 0) {
    throw new Error(`the integration resource cleanup did not complete: ${errors.join('; ')}`)
  }
}
