// The real disposable PostgreSQL proof: the wiring that starts a loopback-only,
// digest-pinned container, provisions the canonical roles through the
// repository's canonical boundary fixture, runs the merged auth schema
// initializer, and removes the container it created.
//
// The proof logic lives in `scripts/disposable-postgres-ci.ts` so it can be
// exercised without a container. This module supplies the real dependencies.
//
// Nothing here reaches a hosted database, a production resource or a
// credential store. The container is published on the loopback interface only,
// the passwords are generated for the run, and the receipt carries none of them.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  captureProvisioningImage,
  dockerCaptureRun,
  dockerDaemonAvailable,
  startFromCaptureImage,
} from './capture-provisioning.mjs'
import {
  LOOPBACK_HOST,
  PROOF_AUTH_SCHEMA,
  runDisposablePostgresProof,
  type DisposableProofDependencies,
  type DisposableProofOptions,
  type ProofQueryResult,
} from './disposable-postgres-ci'
import {
  canonicalUrl,
  createCanonicalDatabase,
  ensureCanonicalRoles,
} from '../packages/db/tests/fixtures/canonical-boundary'
import { applyAuthSchema } from '../packages/auth/src/schema-init'

const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url))
type PostgresFactory = typeof import('postgres').default
const loadedPostgres = dbRequire('postgres') as PostgresFactory | { default: PostgresFactory }
const postgres: PostgresFactory =
  typeof loadedPostgres === 'function' ? loadedPostgres : loadedPostgres.default

/** The repository root, the working directory of every proof command. */
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

/** The base URL the auth initializer validates. It is never contacted. */
const AUTH_BASE_URL = 'https://adea-ci.example.test'

/** The secret the auth initializer validates. It is generated for the run. */
const AUTH_SECRET = 'adea-ci-disposable-auth-secret-0123456789abcdef'

/** The origin the auth initializer validates. */
const AUTH_TRUSTED_ORIGIN = AUTH_BASE_URL

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
  if (result.error) {
    throw new Error(`${what} failed: ${result.error.message}`)
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Creates the owned container from the digest-pinned image, retrying a
 * rate-limited pull from the same digest on the fallback registries the
 * repository already uses. A digest names the content, so a fallback cannot
 * change what runs.
 */
function createContainer(input: {
  name: string
  password: string
  image: string
  startScript: string
}): void {
  const prefix = [
    'create',
    '--name',
    input.name,
    '-p',
    `${LOOPBACK_HOST}::5432`,
    '-e',
    `POSTGRES_PASSWORD=${input.password}`,
    '--entrypoint',
    'sh',
  ]
  const result = startFromCaptureImage((image, remainingMs) => {
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
  if (result.error) {
    throw new Error(`creating the disposable PostgreSQL instance failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error('creating the disposable PostgreSQL instance failed')
  }
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

/**
 * Writes a one-day self-signed certificate for the loopback interface. The
 * disposable instance is bound to loopback and is removed with the run, so the
 * certificate never leaves the machine.
 */
function createCertificate(directory: string): void {
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${directory}/server.key`,
      '-out',
      `${directory}/server.crt`,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    }
  )
  if (result.error || result.status !== 0) {
    throw new Error('generating the disposable instance TLS material failed')
  }
}

/**
 * Creates the canonical roles and the owned database with the repository's
 * canonical boundary fixture, so the proof uses the same role attributes,
 * schema ownership and default privileges as every other lane. The auth
 * schema is created here too, owned by the migration role, because the merged
 * auth schema initializer only ever creates tables inside an existing schema.
 */
async function provision(input: {
  adminUrl: string
  authSchema: string
  database: string
  migrationRole: string
  runtimeRole: string
}): Promise<{
  migrationRole: string
  migrationUrl: string
  runtimeRole: string
  runtimeUrl: string
  unpooledUrl: string
}> {
  const admin = postgres(input.adminUrl, { max: 1, onnotice: () => {} })
  try {
    await ensureCanonicalRoles(admin)
    await createCanonicalDatabase(
      admin,
      (database) => {
        const url = new URL(input.adminUrl)
        url.pathname = `/${database}`
        return url.toString()
      },
      input.database
    )
  } finally {
    await admin.end()
  }

  // The auth schema belongs to the owned database, next to the application
  // schema the canonical fixture created, because that is where the merged auth
  // schema initializer creates the provider tables.
  const ownedUrl = new URL(input.adminUrl)
  ownedUrl.pathname = `/${input.database}`
  const owned = postgres(ownedUrl.toString(), { max: 1, onnotice: () => {} })
  try {
    await owned.unsafe(
      `create schema if not exists ${input.authSchema} authorization ${input.migrationRole}`
    )
    await owned.unsafe(`grant usage on schema ${input.authSchema} to ${input.runtimeRole}`)
  } finally {
    await owned.end()
  }

  const migrationUrl = canonicalUrl(input.adminUrl, input.database, input.migrationRole)
  const runtimeUrl = canonicalUrl(input.adminUrl, input.database, input.runtimeRole)
  return {
    migrationRole: input.migrationRole,
    migrationUrl,
    runtimeRole: input.runtimeRole,
    runtimeUrl,
    unpooledUrl: runtimeUrl,
  }
}

/**
 * Runs one statement against the disposable instance. The application driver is
 * used, so the proof exercises the same transport the application uses: it
 * encrypts the connection and, like the hosted lane, does not verify the
 * disposable server's certificate.
 */
async function query(
  url: string,
  statement: string,
  parameters?: readonly unknown[]
): Promise<ProofQueryResult> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const rows = await sql.unsafe(statement, parameters as unknown[])
    return rows as ProofQueryResult
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** Runs one command of the ordered migration checks. */
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
    timeout: 600_000,
  })
  if (result.error) {
    throw new Error(`${name} could not be started`)
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Removes the owned container and nothing else. */
function removeContainer(name: string): void {
  // The helper throws when the removal fails, so a leaked instance fails the
  // lane instead of being ignored.
  dockerCaptureRun(['rm', '--force', name], 'removing the disposable PostgreSQL instance')
}

const dependencies: DisposableProofDependencies = {
  dockerAvailable: dockerDaemonAvailable,
  opensslAvailable,
  createContainer,
  docker,
  createCertificate,
  provision,
  applyAuthSchema: (environment) => applyAuthSchema(environment),
  command,
  query,
  removeContainer,
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

const options: DisposableProofOptions = {
  image: captureProvisioningImage,
  authSchema: PROOF_AUTH_SCHEMA,
  authBaseUrl: AUTH_BASE_URL,
  authSecret: AUTH_SECRET,
  authTrustedOrigin: AUTH_TRUSTED_ORIGIN,
}

try {
  const receipt = await runDisposablePostgresProof(dependencies, options)
  console.log(`DISPOSABLE_POSTGRES_PROOF ${JSON.stringify(receipt)}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'the disposable PostgreSQL proof failed')
  process.exitCode = 1
}
