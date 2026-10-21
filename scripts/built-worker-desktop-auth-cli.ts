// The real built-Worker desktop authorization qualification.
//
// The qualification runs the Worker that `apps/web` builds against a
// disposable PostgreSQL instance it owns, and proves what the built desktop
// routes do:
//
//   - the routes are registered and answer;
//   - the authorize route refuses a caller without a session and issues an
//     authorization code to a fresh account it signed up itself;
//   - the exchange route turns that code into a desktop session;
//   - the exchange route refuses a wrong PKCE verifier, an untrusted origin
//     and a replayed code;
//   - the exchange preflight refuses an untrusted origin;
//   - no response carries a secret.
//
// It publishes one receipt. The receipt carries every assertion by name, the
// number of assertions that passed, and the full auth lifecycle assertions the
// lane proved against the same instance: a status is not a receipt.
//
// The instance is the lane's own disposable PostgreSQL: a loopback-only,
// digest-pinned container with server-side TLS, the canonical runtime and
// migration roles, the applied migrations and the provider schema. The Worker
// is served from the local build. Nothing here reaches a hosted database, a
// hosted service, a credential store or a production target, and the container
// and the Worker are removed even when a check fails.

import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  captureProvisioningImage,
  dockerDaemonAvailable,
  startFromCaptureImage,
} from './capture-provisioning.mjs'
import {
  attachOwnedContainerCleanup,
  authMigrationUrl as authMigrationUrlFor,
  CANONICAL_MIGRATION_ROLE,
  CANONICAL_RUNTIME_ROLE,
  containerRemovalCommand,
  disposableStartScript,
  PROOF_AUTH_SCHEMA,
  PROOF_DATABASE,
} from './disposable-postgres-ci'
import {
  SELF_HOSTED_AUTH_LIFECYCLE_TEST,
  proveSelfHostedAuthLifecycle,
} from './self-hosted-auth-lifecycle'
import {
  canonicalUrl,
  createCanonicalDatabase,
  ensureCanonicalRoles,
} from '../packages/db/tests/fixtures/canonical-boundary'
import { applyAuthSchema } from '../packages/auth/src/schema-init'
import { classifyDisposableProofEvidence } from './fresh-postgres-acceptance/evidence.mjs'
import { readCheckoutProvenance } from './fresh-postgres-acceptance/provenance.mjs'
import {
  assertBuiltWorkerDesktopAuthPassed,
  parseAuthLifecycleAssertions,
  runBuiltWorkerDesktopAuth,
  type AuthLifecycleEvidence,
} from './fresh-postgres-acceptance/built-worker-desktop-auth'
import {
  assertLocalRuntimePrerequisites,
  buildBuiltWorker,
  buildLocalWorkerConfig,
  builtWorkerArtifact,
  createLoopbackCertificate,
  publishableReceipt,
  removeOwnedMaterial,
  runOwnedSetup,
  startBuiltWorker,
  tearDownAfterWorker,
  waitForWorkerReady,
  verifyBuildProvenance,
  workerTransport,
  writeBuildProvenance,
  type RunningBuiltWorker,
} from './fresh-postgres-acceptance/built-worker-runtime'
import {
  BuiltWorkerFailure,
  failureMessage,
  publishedReceipt,
  sanitizeText,
  sanitizeWorkerLogs,
} from './fresh-postgres-acceptance/built-worker-failures'

const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url))
/** The client the canonical boundary fixture takes. */
type CanonicalAdmin = Parameters<typeof ensureCanonicalRoles>[0]
type PostgresFactory = (
  url: string,
  options?: { max?: number; onnotice?: () => void }
) => CanonicalAdmin
const loadedPostgres = dbRequire('postgres') as PostgresFactory | { default: PostgresFactory }
const postgres: PostgresFactory =
  typeof loadedPostgres === 'function' ? loadedPostgres : loadedPostgres.default

/** The repository root. */
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

/** The provenance of the checkout the qualification runs in. */
const provenance = readCheckoutProvenance(repositoryRoot)

/** The base URL the auth service validates. It is never contacted. */
const AUTH_BASE_URL = 'https://adea-ci.example.test'

/** The secret the auth service signs with. It is generated for the run. */
const AUTH_SECRET = 'adea-built-worker-desktop-auth-secret-0123456789abcdef'

/** Runs one Docker command and reports its status. */
function docker(
  args: readonly string[],
  what: string
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
  if (result.error) throw new Error(`${what} failed: ${result.error.message}`)
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Runs one command in the repository and reports its status. */
function command(
  name: string,
  args: readonly string[],
  environment: Record<string, string | undefined>
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(name, [...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment as NodeJS.ProcessEnv,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 1_800_000,
  })
  if (result.error) throw new Error(`${name} could not be started`)
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * True when the local runtime that serves the built Worker is on the path.
 *
 * The local runtime is a Node program, so a host without it cannot serve the
 * Worker at all. The qualification learns that before it creates anything.
 */
function localRuntimeAvailable(): boolean {
  const result = spawnSync('node', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  return !result.error && result.status === 0
}

/** True when the host can generate the disposable server's TLS material. */
function opensslAvailable(): boolean {
  const result = spawnSync('openssl', ['version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  })
  return !result.error && result.status === 0
}

/** Creates the owned container from the digest-pinned image. */
function createContainer(input: {
  readonly name: string
  readonly password: string
  readonly image: string
  readonly startScript: string
}): void {
  const prefix = [
    'create',
    '--name',
    input.name,
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_PASSWORD=${input.password}`,
    '--entrypoint',
    'sh',
  ]
  const result = startFromCaptureImage((image: string, remainingMs: number) => {
    const started = spawnSync('docker', [...prefix, image, '-c', input.startScript], {
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(1, remainingMs),
    })
    return {
      status: started.status ?? 1,
      stdout: started.stdout ?? '',
      stderr: started.stderr ?? '',
    }
  })
  if (result.error || result.status !== 0) {
    throw new Error('creating the disposable PostgreSQL instance failed')
  }
}

/** Removes the owned container and nothing else. */
function removeContainer(name: string): void {
  const result = spawnSync('docker', containerRemovalCommand(name), {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  if (result.error) throw new Error('removing the disposable PostgreSQL instance failed')
  if (result.status !== 0 && !/no such container/i.test(result.stderr ?? '')) {
    throw new Error('removing the disposable PostgreSQL instance failed')
  }
}

/**
 * Waits until the disposable instance accepts a connection.
 *
 * The instance initializes its own cluster after the container starts, so the
 * first connections are refused or answered with "the database system is
 * starting up". The qualification waits for the instance instead of failing on
 * the first attempt.
 */
async function waitForDatabase(url: string): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const probe = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await probe`select 1`
      await probe.end({ timeout: 5 })
      return
    } catch {
      await probe.end({ timeout: 1 }).catch(() => undefined)
      if (Date.now() >= deadline) {
        throw new Error('the disposable PostgreSQL instance never became ready')
      }
      await new Promise((done) => setTimeout(done, 500))
    }
  }
}

/** Finds a free port on the loopback interface. */
async function availablePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((ok, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? ok(port) : fail(new Error('no port was allocated'))))
    })
  })
}

async function main(): Promise<void> {
  // The host capabilities are checked before any resource is created, through
  // the same contract the offline tests pin.
  assertLocalRuntimePrerequisites({
    hasContainerRuntime: dockerDaemonAvailable(),
    hasCertificateTool: opensslAvailable(),
    hasLocalRuntime: localRuntimeAvailable(),
  })

  // The Worker this qualification proves. A build that cannot be placed in
  // this checkout is not reused: the qualification builds the Worker itself and
  // records which checkout the build came from, so the receipt can name the
  // artifact it actually proved.
  let artifact = builtWorkerArtifact(repositoryRoot)
  let verified =
    artifact !== null &&
    verifyBuildProvenance({ root: repositoryRoot, artifact, source: provenance })
  if (!artifact || !verified) {
    buildBuiltWorker(repositoryRoot)
    artifact = builtWorkerArtifact(repositoryRoot)
    if (!artifact) {
      throw new BuiltWorkerFailure(
        'artifact-unavailable',
        'the built Worker is absent after the build'
      )
    }
    writeBuildProvenance({ root: repositoryRoot, artifact, source: provenance })
    verified = verifyBuildProvenance({ root: repositoryRoot, artifact, source: provenance })
    if (!verified) {
      throw new BuiltWorkerFailure(
        'artifact-provenance-unverified',
        'the built Worker could not be placed in this checkout'
      )
    }
  }

  const containerName = `adea-built-worker-desktop-${randomBytes(6).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  const directory = mkdtempSync(join(tmpdir(), 'adea-built-worker-desktop-'))
  let worker: RunningBuiltWorker | undefined
  // The Worker runtime may only read files under the Worker's own directory,
  // so the instance's certificate is copied into the build output the Worker
  // runs from. The copy is removed with the run.
  const workerCertificate = join(
    repositoryRoot,
    'apps/web/dist/server/built-worker-desktop-auth-ca.crt'
  )
  // The owned cleanup is installed before anything is created, so a failure in
  // the setup leaves no material behind.
  const cleanup = attachOwnedContainerCleanup({
    name: containerName,
    remove: removeContainer,
    removeTemporaryMaterial: () => {
      // The Worker is asked to stop before its material goes, so an
      // interrupted run does not leave a Worker serving from removed files. The
      // material is only removed once the process group is gone: an
      // interruption that arrives during the startup is no different from one
      // that arrives later.
      removeOwnedMaterial({
        worker,
        remove: () => {
          rmSync(workerCertificate, { force: true })
          rmSync(directory, { recursive: true, force: true })
        },
        onRetained: (message) => {
          console.error(message)
        },
      })
    },
    reportFailure: (message) => {
      console.error(`the built-Worker qualification cleanup failed: ${message}`)
    },
  })
  // The ordinary exit path has no signal handler, so the owned teardown runs
  // there as well. It is idempotent.
  process.once('exit', () => {
    try {
      cleanup.teardown()
    } catch {
      // An exiting process cannot report a cleanup failure.
    }
  })
  let bodyError: unknown
  let receipt: Awaited<ReturnType<typeof runBuiltWorkerDesktopAuth>> | undefined

  try {
    // The owned setup is inside the protected body: a failure to mint the
    // certificate or to copy it into the Worker's directory is an ordinary
    // failure, and the owned cleanup runs for it.
    const certificate = await runOwnedSetup({
      setup: () => {
        const minted = createLoopbackCertificate(directory)
        mkdirSync(join(repositoryRoot, 'apps/web/dist/server'), { recursive: true })
        copyFileSync(minted.certificatePath, workerCertificate)
        return minted
      },
      teardown: () => cleanup.teardown(),
    })
    createContainer({
      name: containerName,
      password,
      image: captureProvisioningImage,
      startScript: disposableStartScript(),
    })
    const copied = docker(
      ['cp', `${directory}/.`, `${containerName}:/tmp/incoming`],
      'copying the TLS material into the disposable instance'
    )
    if (copied.status !== 0) {
      throw new Error('copying the TLS material into the disposable instance failed')
    }
    const started = docker(['start', containerName], 'starting the disposable instance')
    if (started.status !== 0) {
      throw new Error('starting the disposable PostgreSQL instance failed')
    }
    const mapping = docker(['port', containerName, '5432/tcp'], 'reading the instance port')
    if (mapping.status !== 0) throw new Error('reading the disposable instance port failed')
    const port = mapping.stdout.trim().split(/\r?\n/).at(-1)?.split(':').at(-1)
    if (!port) throw new Error('the disposable instance port mapping was unreadable')

    const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=require&connect_timeout=10`
    await waitForDatabase(adminUrl)
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
    try {
      await ensureCanonicalRoles(admin)
      await createCanonicalDatabase(
        admin,
        (database) => {
          const url = new URL(adminUrl)
          url.pathname = `/${database}`
          return url.toString()
        },
        PROOF_DATABASE
      )
    } finally {
      await admin.end().catch(() => undefined)
    }

    const migrationUrl = canonicalUrl(adminUrl, PROOF_DATABASE, CANONICAL_MIGRATION_ROLE)
    const runtimeUrl = canonicalUrl(adminUrl, PROOF_DATABASE, CANONICAL_RUNTIME_ROLE)
    // The migration checks run in a minimal environment: only the three
    // canonical URLs and the settings a command needs to start at all. Nothing
    // else is inherited, so a shell cannot point them at a hosted database.
    const databaseEnvironment: Record<string, string | undefined> = {}
    for (const name of ['PATH', 'TMPDIR', 'LANG']) {
      if (process.env[name]) databaseEnvironment[name] = process.env[name]
    }
    databaseEnvironment.DATABASE_URL = runtimeUrl
    databaseEnvironment.DATABASE_URL_UNPOOLED = runtimeUrl
    databaseEnvironment.DATABASE_MIGRATION_URL = migrationUrl
    const migrated = command(
      'bun',
      ['run', '--cwd', 'packages/db', 'db:verify'],
      databaseEnvironment
    )
    if (migrated.status !== 0) {
      throw new Error('applying the migrations to the disposable instance failed')
    }

    // The provider schema, owned by the migration role, with the runtime role
    // able to read and write the provider tables. This is the operator step a
    // hosted instance performs in its role script.
    const owned = postgres(migrationUrl, { max: 1, onnotice: () => {} })
    try {
      await owned.unsafe(
        `create schema if not exists ${PROOF_AUTH_SCHEMA} authorization ${CANONICAL_MIGRATION_ROLE}`
      )
      await owned.unsafe(`grant usage on schema ${PROOF_AUTH_SCHEMA} to ${CANONICAL_RUNTIME_ROLE}`)
      await owned.unsafe(
        `alter default privileges for role ${CANONICAL_MIGRATION_ROLE} in schema ${PROOF_AUTH_SCHEMA} grant select, insert, update, delete on tables to ${CANONICAL_RUNTIME_ROLE}`
      )
    } finally {
      await owned.end().catch(() => undefined)
    }
    // The auth schema initializer connects with the `pg` driver, which verifies
    // the server certificate. The instance's own certificate is pinned, so the
    // initializer connects with that certificate and the provider schema.
    const authMigrationUrl = authMigrationUrlFor(
      migrationUrl,
      certificate.certificatePath,
      PROOF_AUTH_SCHEMA
    )
    const applied = await applyAuthSchema({
      AUTH_MIGRATION_DATABASE_URL: authMigrationUrl.toString(),
      AUTH_BASE_URL: AUTH_BASE_URL,
      AUTH_SECRET: AUTH_SECRET,
      AUTH_TRUSTED_ORIGINS: AUTH_BASE_URL,
      AUTH_SECURE_COOKIES: 'true',
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'false',
    })
    if (applied.applied !== true) {
      throw new Error('the auth schema initializer did not apply the provider tables')
    }
    const granted = postgres(migrationUrl, { max: 1, onnotice: () => {} })
    try {
      await granted.unsafe(
        `grant select, insert, update, delete on all tables in schema ${PROOF_AUTH_SCHEMA} to ${CANONICAL_RUNTIME_ROLE}`
      )
    } finally {
      await granted.end().catch(() => undefined)
    }

    // The auth lifecycle, proved against the same instance, with every
    // assertion it reported preserved for the receipt.
    let lifecycleOutput = ''
    proveSelfHostedAuthLifecycle(
      (name, args, environment) => {
        const result = command(name, args, environment)
        lifecycleOutput = `${result.stdout}\n${result.stderr}`
        return result
      },
      {
        databaseUrl: (() => {
          const url = new URL(adminUrl)
          url.pathname = `/${PROOF_DATABASE}`
          url.search = ''
          url.searchParams.set('sslmode', 'verify-full')
          url.searchParams.set('sslrootcert', certificate.certificatePath)
          return url.toString()
        })(),
      },
      { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG }
    )
    const lifecycle = parseAuthLifecycleAssertions(lifecycleOutput)
    if (lifecycle.assertions.length === 0) {
      throw new Error(
        'the auth lifecycle reported no assertion; a receipt without one is not a receipt'
      )
    }
    const authLifecycle: AuthLifecycleEvidence = {
      suite: SELF_HOSTED_AUTH_LIFECYCLE_TEST,
      assertions: lifecycle.assertions,
      passed: lifecycle.passed,
    }

    // The Worker, served from the build, against the instance this run owns.
    const workerPort = await availablePort()
    const baseUrl = `https://127.0.0.1:${workerPort}`
    // The auth service connects with the `pg` driver. The Worker runtime may
    // not read a certificate from disk, and the application's own rule allows
    // a plaintext connection to a loopback host, so the provider connection
    // uses the loopback development policy the repository's own local Worker
    // acceptance uses. The application connection stays encrypted.
    const authDatabaseUrl = new URL(runtimeUrl)
    authDatabaseUrl.searchParams.set('options', `-c search_path=${PROOF_AUTH_SCHEMA}`)
    authDatabaseUrl.searchParams.set('sslmode', 'disable')
    // The Worker reaches the disposable instance over the loopback interface
    // with the repository's own local Worker policy: the application
    // configuration allows a plaintext connection to a loopback host, and the
    // repository's local Worker acceptance connects the same way. The hosted
    // lane's encrypted, verified connection is unchanged.
    const workerDatabaseUrl = new URL(runtimeUrl)
    workerDatabaseUrl.searchParams.set('sslmode', 'disable')
    const config = buildLocalWorkerConfig({
      artifact,
      baseUrl,
      databaseUrl: workerDatabaseUrl.toString(),
      authDatabaseUrl: authDatabaseUrl.toString(),
      authSecret: AUTH_SECRET,
    })
    worker = await startBuiltWorker({
      root: repositoryRoot,
      artifact,
      config,
      configPath: join(directory, 'worker.json'),
      port: workerPort,
      certificatePath: certificate.certificatePath,
      keyPath: certificate.keyPath,
      persistDirectory: join(directory, 'worker-state'),
    })
    // The readiness is waited for separately: a run that fails here still owns
    // a running Worker, and the teardown has to be able to stop it.
    await waitForWorkerReady({
      worker,
      certificatePath: certificate.certificatePath,
    })

    receipt = await runBuiltWorkerDesktopAuth({
      transport: workerTransport({
        baseUrl: worker.baseUrl,
        certificatePath: certificate.certificatePath,
      }),
      baseUrl: worker.baseUrl,
      artifact: {
        digest: artifact.digest,
        sha: provenance.sha,
        dirty: provenance.dirty,
        verified,
      },
      secrets: [AUTH_SECRET, password],
      authLifecycle,
      evidence: classifyDisposableProofEvidence(process.env),
      checkout: provenance,
      module: provenance,
    })
  } catch (error) {
    bodyError = error
  }

  // The Worker is stopped and its shutdown is confirmed before the runtime
  // material and the container are removed: the material must not disappear
  // while the process that reads it is still alive.
  let stopError: unknown
  let cleanupError: unknown
  let verdict = { workerStopped: false, containerRemoved: false, materialRemoved: false }
  try {
    const teardown = await tearDownAfterWorker({
      worker,
      removeContainer: () => removeContainer(containerName),
      removeMaterial: () => {
        rmSync(workerCertificate, { force: true })
        rmSync(directory, { recursive: true, force: true })
      },
      onFailure: (message) => {
        console.error(message)
      },
    })
    verdict = {
      workerStopped: teardown.workerStopped,
      containerRemoved: teardown.containerRemoved,
      materialRemoved: teardown.materialRemoved,
    }
    if (!teardown.workerStopped) stopError = teardown.stopError
  } catch (error) {
    cleanupError = error
  }

  // A failed qualification still publishes the assertions it made, how many
  // attempts each made and how every attempt ended. The receipt is the
  // evidence; the exit status is the verdict.
  //
  // The receipt is published only after the Worker was stopped and the
  // material was removed: a receipt that claims a pass must not be published
  // while the Worker is still running or its material is still there.
  const published =
    receipt &&
    publishableReceipt({
      receipt,
      verdict,
      cleanupFailed: cleanupError !== undefined,
    })
  if (published) {
    // The published receipt is sanitized again, on the way out: the receipt is
    // the evidence of the run, and it must not carry a value.
    const sanitized = publishedReceipt({
      receipt: published,
      verdict,
      secrets: [AUTH_SECRET, password],
    })
    console.log(`BUILT_WORKER_DESKTOP_AUTH ${JSON.stringify(sanitized)}`)
  }

  const failures = [bodyError, stopError, cleanupError].filter(
    (failure): failure is unknown => failure !== undefined
  )
  if (failures.length === 0) {
    if (receipt) assertBuiltWorkerDesktopAuthPassed(receipt)
    return
  }
  const reported = failures.map((failure) => describeFailure(failure, [AUTH_SECRET, password]))
  const evidence = sanitizeWorkerLogs(worker?.logs ?? [], [AUTH_SECRET, password])
  const detail = [
    reported.join('; '),
    evidence.length > 0 ? `the Worker said: ${evidence.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('; ')
  throw new BuiltWorkerFailure(
    failures[0] === stopError
      ? 'worker-stop-failed'
      : failures[0] === cleanupError
        ? 'cleanup-failed'
        : 'unexpected-failure',
    detail,
    { cause: failures[0] }
  )
}

/**
 * The published description of a failure: its fixed kind and a redacted
 * detail. A raw exception message or a raw runtime log line can carry the
 * instance password or the auth secret, so neither is published.
 */
function describeFailure(error: unknown, secrets: readonly string[]): string {
  if (error instanceof BuiltWorkerFailure) return failureMessage(error)
  return `unexpected-failure: ${sanitizeText(
    error instanceof Error ? error.message : String(error),
    secrets
  )}`
}

try {
  await main()
} catch (error) {
  console.error(describeFailure(error, [AUTH_SECRET]))
  process.exitCode = 1
}
