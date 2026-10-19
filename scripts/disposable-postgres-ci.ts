// A bounded, database-only CI proof over a disposable PostgreSQL instance.
//
// This lane is additive. The hosted Neon branch, its Neon Auth JWKS proof, the
// `Migrate Neon Branch` gate and every existing secret stay exactly as they are.
// This module adds a second, database-only proof over a loopback-only,
// digest-pinned PostgreSQL container that the lane creates, proves against and
// removes.
//
// The proof keeps the hosted lane's ordering for the checks the two share: the
// role probe, the Drizzle journal check, the migration verifier, the
// `DATABASE_URL` presence check and the migration integration test run in the
// same sequence against the same three canonical URLs. It adds what a
// disposable instance can prove that a hosted branch was never asked for: an
// encrypted connection the server itself reports, the canonical
// runtime/migration role boundary, and the merged auth schema initializer
// applying once and replaying as a no-op.
//
// Every database step here is provider-neutral. The module holds no credential,
// no hosted endpoint and no production target: it starts a container on the
// loopback interface, and it removes only the container it created. Nothing it
// prints carries a password, a credential-bearing URL, a cookie or a token.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The canonical migration role the repository's canonical boundary fixture uses. */
export const CANONICAL_MIGRATION_ROLE = 'agent_hq_local_migration'

/** The canonical runtime role the repository's canonical boundary fixture uses. */
export const CANONICAL_RUNTIME_ROLE = 'agent_hq_local_app'

/** The database the proof owns. It is created for the run and dropped with it. */
export const PROOF_DATABASE = 'adea_ci_proof'

/** The schema the merged auth schema initializer owns. */
export const PROOF_AUTH_SCHEMA = 'auth_ci'

/** The only interface the disposable instance is published on. */
export const LOOPBACK_HOST = '127.0.0.1'

/** The application schema the canonical boundary fixture creates. */
export const PROOF_APP_SCHEMA = 'app'

/** The transport modes the repository accepts for an encrypted connection. */
export const TLS_MODES = ['require', 'verify-ca', 'verify-full'] as const

/**
 * The checks the hosted lane runs, in the hosted lane's order.
 *
 * `assert-url-present` is the hosted lane's `test -n "$DATABASE_URL"` step: the
 * environment must name the database before the integration test runs. The
 * order is part of the contract, so it is data rather than a sequence of calls.
 */
export type ProofStep =
  | { readonly kind: 'command'; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: 'assert-url-present'; readonly name: string }

export const PROOF_MIGRATION_STEPS: readonly ProofStep[] = [
  { kind: 'command', command: 'node', args: ['scripts/database-health.mjs'] },
  {
    kind: 'command',
    command: 'bun',
    args: ['--no-env-file', 'run', '--cwd', 'packages/db', 'db:check'],
  },
  {
    kind: 'command',
    command: 'bun',
    args: ['--no-env-file', 'run', '--cwd', 'packages/db', 'db:verify'],
  },
  { kind: 'assert-url-present', name: 'DATABASE_URL' },
  {
    kind: 'command',
    command: 'bun',
    args: [
      '--no-env-file',
      '--conditions=react-server',
      'test',
      'packages/db/tests/integration/migrations.test.ts',
    ],
  },
]

/** One command the proof ran, recorded for the receipt. */
export type ProofCommandRecord = {
  readonly command: string
  readonly args: readonly string[]
}

/** The result of one query against the disposable instance. */
export type ProofQueryResult = ReadonlyArray<Record<string, unknown>>

/** The URLs and role names the canonical boundary fixture provisioned. */
export type ProvisionedDatabase = {
  readonly migrationRole: string
  readonly migrationUrl: string
  readonly runtimeRole: string
  readonly runtimeUrl: string
  readonly unpooledUrl: string
}

/** What the merged auth schema initializer reports. */
export type AuthSchemaResult = {
  readonly applied: boolean
  readonly before: { readonly add: readonly string[]; readonly create: readonly string[] }
  readonly after?: { readonly add: readonly string[]; readonly create: readonly string[] }
}

/**
 * Everything the proof needs from its environment, injected so the proof can be
 * exercised without a container, a database or a network.
 */
export type DisposableProofDependencies = {
  /** True when a usable Docker daemon is reachable. */
  readonly dockerAvailable: () => boolean
  /** True when the host can generate the disposable server's TLS material. */
  readonly opensslAvailable: () => boolean
  /** Creates the owned container. Throws when the creation fails. */
  readonly createContainer: (input: {
    readonly name: string
    readonly password: string
    readonly image: string
    readonly startScript: string
  }) => void
  /** Runs one Docker command. */
  readonly docker: (
    args: readonly string[],
    what: string
  ) => { status: number; stdout: string; stderr: string }
  /** Writes the server certificate and key into `directory`. */
  readonly createCertificate: (directory: string) => void
  /** Creates the canonical roles, the owned database and the auth schema. */
  readonly provision: (input: {
    readonly adminUrl: string
    readonly authSchema: string
    readonly database: string
    readonly migrationRole: string
    readonly runtimeRole: string
  }) => Promise<ProvisionedDatabase>
  /** Runs the merged auth schema initializer. */
  readonly applyAuthSchema: (
    environment: Record<string, string | undefined>
  ) => Promise<AuthSchemaResult>
  /** Runs one command of the ordered migration checks. */
  readonly command: (
    command: string,
    args: readonly string[],
    environment: Record<string, string | undefined>
  ) => { status: number; stdout: string; stderr: string }
  /** Runs one statement against the disposable instance. */
  readonly query: (
    url: string,
    statement: string,
    parameters?: readonly unknown[]
  ) => Promise<ProofQueryResult>
  /** Removes the owned container. Throws when the removal fails. */
  readonly removeContainer: (name: string) => void
  /** The current time in milliseconds. */
  readonly now: () => number
  /** Waits for the given number of milliseconds. */
  readonly sleep: (milliseconds: number) => Promise<void>
}

/** The receipt the proof emits. It never carries a credential. */
export type DisposableProofReceipt = {
  readonly status: 'passed'
  readonly database: string
  readonly roles: { readonly runtime: string; readonly migration: string }
  readonly tls: {
    readonly serverSsl: string
    readonly sessionEncrypted: boolean
    readonly plaintextSessionEncrypted: boolean
  }
  readonly migrations: { readonly checks: readonly ProofCommandRecord[] }
  readonly auth: {
    readonly applied: boolean
    readonly created: readonly string[]
    readonly replayApplied: boolean
    readonly schema: string
  }
}

/** The options the proof runs with. */
export type DisposableProofOptions = {
  /** The digest-pinned image the disposable instance runs. */
  readonly image: string
  /** The name of the provider schema the auth initializer owns. */
  readonly authSchema: string
  /** The base URL the auth initializer validates. */
  readonly authBaseUrl: string
  /** The secret the auth initializer validates. */
  readonly authSecret: string
  /** The trusted origin the auth initializer validates. */
  readonly authTrustedOrigin: string
}

/** How long the instance may take to accept connections. */
const READINESS_TIMEOUT_MS = 60_000

/** How often the readiness probe is repeated. */
const READINESS_INTERVAL_MS = 1_000

/** The tables the merged auth schema initializer owns. */
const EXPECTED_AUTH_TABLES = ['account', 'session', 'user', 'verification'] as const

/**
 * The container command. The official entrypoint runs as root before it drops
 * to the `postgres` user, so the certificate is copied into place and given to
 * the server user here, before the server starts with TLS enabled.
 */
export function disposableStartScript(certificateDirectory = '/certs'): string {
  return [
    `mkdir -p ${certificateDirectory} /tmp/incoming`,
    `cp /tmp/incoming/server.key /tmp/incoming/server.crt ${certificateDirectory}/`,
    `chown postgres:postgres ${certificateDirectory}/server.key ${certificateDirectory}/server.crt`,
    `chmod 600 ${certificateDirectory}/server.key`,
    `chmod 644 ${certificateDirectory}/server.crt`,
    `exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=${certificateDirectory}/server.crt -c ssl_key_file=${certificateDirectory}/server.key`,
  ].join(' && ')
}

/**
 * Removes every occurrence of a secret from text. The proof never prints a
 * password, but a driver or a database may echo one back inside an error, and
 * that error must not carry it out.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    redacted = redacted.split(secret).join('[redacted]')
  }
  return redacted
}

/**
 * The environment the ordered migration checks run in. Only the three canonical
 * URLs are added to a minimal inherited environment, so a developer's shell or
 * an agent's environment can never point the checks at a hosted database.
 */
export function proofEnvironment(
  provisioned: ProvisionedDatabase,
  inherited: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {}
  for (const name of ['PATH', 'TMPDIR', 'LANG']) {
    if (inherited[name]) environment[name] = inherited[name]
  }
  environment.DATABASE_URL = provisioned.runtimeUrl
  environment.DATABASE_URL_UNPOOLED = provisioned.unpooledUrl
  environment.DATABASE_MIGRATION_URL = provisioned.migrationUrl
  return environment
}

/**
 * Checks one canonical URL: it must name the loopback interface, carry exactly
 * one transport parameter, and that parameter must be the expected encrypted
 * mode.
 *
 * The hosted rules are unchanged and stay binding for a hosted host; a loopback
 * disposable instance is the one case where they would not apply, so the proof
 * asserts the requirement itself instead of inheriting it.
 */
export function assertLoopbackTlsUrl(
  value: string,
  name: string,
  expectedSslMode: (typeof TLS_MODES)[number] = 'require'
): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must use the PostgreSQL protocol`)
  }
  if (url.hostname !== LOOPBACK_HOST) {
    throw new Error(`${name} must stay on the loopback interface`)
  }
  if (!url.username || !url.password) {
    throw new Error(`${name} must name a role and a password`)
  }
  for (const parameter of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey']) {
    if (url.searchParams.getAll(parameter).length > 1) {
      throw new Error(`${name} must not repeat the ${parameter} parameter`)
    }
  }
  if (url.searchParams.has('sslmode') && url.searchParams.has('ssl')) {
    throw new Error(`${name} must not combine the sslmode and ssl parameters`)
  }
  if (url.searchParams.get('sslmode') !== expectedSslMode) {
    throw new Error(`${name} must use sslmode=${expectedSslMode}`)
  }
  return url
}

/** The same URL with TLS turned off, used to prove the encryption check bites. */
export function plaintextUrl(value: string): string {
  const url = new URL(value)
  url.searchParams.set('sslmode', 'disable')
  return url.toString()
}

/**
 * The URL the merged auth schema initializer connects with. The application
 * driver encrypts without verifying, exactly as the hosted lane does, but the
 * auth driver refuses to disable certificate verification, so the initializer
 * connects with the pinned certificate instead.
 */
export function authMigrationUrl(
  migrationUrl: string,
  certificatePath: string,
  authSchema: string
): string {
  const url = new URL(migrationUrl)
  url.searchParams.set('sslmode', 'verify-full')
  url.searchParams.set('sslrootcert', certificatePath)
  url.searchParams.set('options', `-c search_path=${authSchema}`)
  return url.toString()
}

function firstValue(rows: ProofQueryResult, column: string): unknown {
  const row = rows[0]
  if (!row) throw new Error(`the query returned no row for ${column}`)
  return row[column]
}

/**
 * PostgreSQL reports a boolean as `t`/`f` over the wire. The application
 * driver decodes it to a JavaScript boolean, while libpq keeps the text, so
 * both shapes are accepted.
 */
function isTrue(value: unknown): boolean {
  return value === true || value === 't'
}

function isFalse(value: unknown): boolean {
  return value === false || value === 'f'
}

function ownerOf(rows: ProofQueryResult, schema: string): string {
  const owner = firstValue(rows, 'owner')
  if (typeof owner !== 'string')
    throw new Error(`the ownership query returned no owner for ${schema}`)
  return owner
}

/**
 * Installs the cleanup that removes the owned container when the run is
 * interrupted. The signal is re-raised after the removal so the process still
 * ends the way the signal asked it to.
 */
export function attachOwnedContainerCleanup(options: {
  readonly name: string
  readonly remove: (name: string) => void
  readonly onSignal?: (signal: NodeJS.Signals) => void
}): () => void {
  const handler = (signal: NodeJS.Signals) => {
    if (options.onSignal) {
      options.onSignal(signal)
      return
    }
    options.remove(options.name)
    process.kill(process.pid, signal)
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  return () => {
    process.off('SIGINT', handler)
    process.off('SIGTERM', handler)
  }
}

/**
 * Runs the disposable PostgreSQL proof.
 *
 * The proof fails loudly: an unavailable container runtime, a failed migration,
 * a refused privilege or a failed cleanup all fail the lane. It never reports a
 * skipped run as a pass.
 */
export async function runDisposablePostgresProof(
  dependencies: DisposableProofDependencies,
  options: DisposableProofOptions
): Promise<DisposableProofReceipt> {
  if (!dependencies.dockerAvailable()) {
    throw new Error(
      'Docker is unavailable; the disposable PostgreSQL proof did not run and must not be reported as a pass'
    )
  }
  if (!dependencies.opensslAvailable()) {
    throw new Error(
      'OpenSSL is unavailable; the disposable PostgreSQL proof cannot enable server-side TLS'
    )
  }

  const containerName = `adea-ci-postgres-${randomBytes(6).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  const directory = mkdtempSync(join(tmpdir(), 'adea-ci-postgres-'))
  const certificatePath = join(directory, 'server.crt')
  const secrets = [password]
  let detach: (() => void) | undefined
  let bodyError: unknown
  let receipt: DisposableProofReceipt | undefined

  try {
    dependencies.createCertificate(directory)
    dependencies.createContainer({
      name: containerName,
      password,
      image: options.image,
      startScript: disposableStartScript(),
    })
    detach = attachOwnedContainerCleanup({
      name: containerName,
      remove: dependencies.removeContainer,
    })

    const copied = dependencies.docker(
      ['cp', `${directory}/.`, `${containerName}:/tmp/incoming`],
      'copying the TLS material into the disposable PostgreSQL instance'
    )
    if (copied.status !== 0) {
      throw new Error('copying the TLS material into the disposable instance failed')
    }

    const started = dependencies.docker(
      ['start', containerName],
      'starting the disposable PostgreSQL instance'
    )
    if (started.status !== 0) {
      throw new Error('starting the disposable PostgreSQL instance failed')
    }

    const mapping = dependencies.docker(
      ['port', containerName, '5432/tcp'],
      'reading the disposable instance port mapping'
    )
    if (mapping.status !== 0) {
      throw new Error('reading the disposable instance port mapping failed')
    }
    const port = mapping.stdout.trim().split(/\r?\n/).at(-1)?.split(':').at(-1)
    if (!port) throw new Error('the disposable instance port mapping was unreadable')

    const deadline = dependencies.now() + READINESS_TIMEOUT_MS
    for (;;) {
      const probe = dependencies.docker(
        ['exec', containerName, 'pg_isready', '-h', LOOPBACK_HOST, '-U', 'postgres'],
        'probing the disposable instance'
      )
      if (probe.status === 0) break
      if (dependencies.now() >= deadline) {
        throw new Error('the disposable PostgreSQL instance never became ready')
      }
      await dependencies.sleep(READINESS_INTERVAL_MS)
    }

    const adminUrl = `postgresql://postgres:${password}@${LOOPBACK_HOST}:${port}/postgres?sslmode=require&connect_timeout=10`
    const provisioned = await dependencies.provision({
      adminUrl,
      authSchema: options.authSchema,
      database: PROOF_DATABASE,
      migrationRole: CANONICAL_MIGRATION_ROLE,
      runtimeRole: CANONICAL_RUNTIME_ROLE,
    })
    if (
      provisioned.migrationRole !== CANONICAL_MIGRATION_ROLE ||
      provisioned.runtimeRole !== CANONICAL_RUNTIME_ROLE
    ) {
      throw new Error('the proof must use the canonical runtime and migration roles')
    }
    assertLoopbackTlsUrl(provisioned.runtimeUrl, 'DATABASE_URL')
    assertLoopbackTlsUrl(provisioned.unpooledUrl, 'DATABASE_URL_UNPOOLED')
    assertLoopbackTlsUrl(provisioned.migrationUrl, 'DATABASE_MIGRATION_URL')

    const environment = proofEnvironment(provisioned)
    const tls = await proveServerSideTls(dependencies, provisioned)
    await proveRoleBoundary(dependencies, provisioned, options)
    const checks = await runOrderedMigrationChecks(dependencies, environment)
    await proveRuntimeDml(dependencies, provisioned)
    const auth = await proveAuthSchemaInitialization(dependencies, provisioned, options, {
      authMigrationUrl: authMigrationUrl(
        provisioned.migrationUrl,
        certificatePath,
        options.authSchema
      ),
    })

    receipt = {
      status: 'passed',
      database: PROOF_DATABASE,
      roles: { runtime: CANONICAL_RUNTIME_ROLE, migration: CANONICAL_MIGRATION_ROLE },
      tls,
      migrations: { checks },
      auth: {
        applied: auth.applied,
        created: auth.created,
        replayApplied: auth.replayApplied,
        schema: options.authSchema,
      },
    }
  } catch (error) {
    bodyError = error
  }

  let cleanupError: unknown
  try {
    detach?.()
    dependencies.removeContainer(containerName)
  } catch (error) {
    cleanupError = error
  }
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch (error) {
    if (cleanupError === undefined) cleanupError = error
  }

  if (bodyError !== undefined && cleanupError !== undefined) {
    throw new Error(
      `the disposable PostgreSQL proof failed: ${redactSecrets(String(bodyError), secrets)}; cleanup also failed: ${redactSecrets(String(cleanupError), secrets)}`
    )
  }
  if (bodyError !== undefined) {
    throw new Error(
      `the disposable PostgreSQL proof failed: ${redactSecrets(String(bodyError), secrets)}`
    )
  }
  if (cleanupError !== undefined) {
    throw new Error(
      `the disposable PostgreSQL proof could not clean up its container: ${redactSecrets(String(cleanupError), secrets)}`
    )
  }
  return receipt as DisposableProofReceipt
}

/**
 * Proves the connection to the disposable instance is encrypted, and that the
 * check would notice a plaintext connection. The server reports both.
 */
async function proveServerSideTls(
  dependencies: DisposableProofDependencies,
  provisioned: ProvisionedDatabase
): Promise<DisposableProofReceipt['tls']> {
  const configuration = await dependencies.query(provisioned.runtimeUrl, 'SHOW ssl')
  const serverSsl = firstValue(configuration, 'ssl')
  if (typeof serverSsl !== 'string') {
    throw new Error('the disposable instance did not report its server TLS setting')
  }
  if (serverSsl !== 'on') {
    throw new Error('the disposable instance does not have server-side TLS enabled')
  }

  const encrypted = await dependencies.query(
    provisioned.runtimeUrl,
    'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()'
  )
  if (!isTrue(firstValue(encrypted, 'ssl'))) {
    throw new Error('the disposable instance connection was not encrypted')
  }

  const plaintext = await dependencies.query(
    plaintextUrl(provisioned.runtimeUrl),
    'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()'
  )
  if (!isFalse(firstValue(plaintext, 'ssl'))) {
    throw new Error('the disposable instance encryption check cannot tell a plaintext session')
  }

  return { serverSsl, sessionEncrypted: true, plaintextSessionEncrypted: false }
}

/**
 * Proves the canonical role boundary: the migration role owns the schemas, and
 * the runtime role may not create objects in them.
 */
async function proveRoleBoundary(
  dependencies: DisposableProofDependencies,
  provisioned: ProvisionedDatabase,
  options: DisposableProofOptions
): Promise<void> {
  const ownership = await dependencies.query(
    provisioned.migrationUrl,
    `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = '${PROOF_APP_SCHEMA}'`
  )
  if (ownerOf(ownership, PROOF_APP_SCHEMA) !== provisioned.migrationRole) {
    throw new Error('the application schema is not owned by the canonical migration role')
  }

  const privilege = await dependencies.query(
    provisioned.runtimeUrl,
    `SELECT has_schema_privilege(current_user, '${PROOF_APP_SCHEMA}', 'CREATE') AS ddl`
  )
  if (!isFalse(firstValue(privilege, 'ddl'))) {
    throw new Error('the runtime role may create objects in the application schema')
  }
  await expectRefused(
    dependencies,
    provisioned.runtimeUrl,
    `CREATE TABLE ${PROOF_APP_SCHEMA}.runtime_ddl_probe (id integer)`,
    'the runtime role created an object in the application schema'
  )

  const authOwnership = await dependencies.query(
    provisioned.migrationUrl,
    `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = '${options.authSchema}'`
  )
  if (ownerOf(authOwnership, options.authSchema) !== provisioned.migrationRole) {
    throw new Error('the auth schema is not owned by the canonical migration role')
  }
  const authPrivilege = await dependencies.query(
    provisioned.runtimeUrl,
    `SELECT has_schema_privilege(current_user, '${options.authSchema}', 'CREATE') AS ddl`
  )
  if (!isFalse(firstValue(authPrivilege, 'ddl'))) {
    throw new Error('the runtime role may create objects in the auth schema')
  }
}

/** Runs a statement that must be refused, and fails when it is not. */
async function expectRefused(
  dependencies: DisposableProofDependencies,
  url: string,
  statement: string,
  message: string
): Promise<void> {
  try {
    await dependencies.query(url, statement)
  } catch {
    return
  }
  throw new Error(message)
}

/**
 * Runs the ordered migration checks. Their order is the hosted lane's order and
 * is part of the contract.
 */
async function runOrderedMigrationChecks(
  dependencies: DisposableProofDependencies,
  environment: Record<string, string | undefined>
): Promise<ProofCommandRecord[]> {
  const records: ProofCommandRecord[] = []
  for (const step of PROOF_MIGRATION_STEPS) {
    if (step.kind === 'assert-url-present') {
      if (!environment[step.name]) {
        throw new Error(`${step.name} must be set before the migration checks continue`)
      }
      continue
    }
    const result = dependencies.command(step.command, step.args, environment)
    if (result.status !== 0) {
      // The output is carried so the failure says what went wrong. The caller
      // redacts every secret before the message leaves the proof.
      const detail = result.stderr.trim().slice(0, 500)
      throw new Error(
        `${step.command} ${step.args.join(' ')} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`
      )
    }
    records.push({ command: step.command, args: step.args })
  }
  return records
}

/**
 * Proves the runtime role may write through the application tables the
 * migration role created.
 */
async function proveRuntimeDml(
  dependencies: DisposableProofDependencies,
  provisioned: ProvisionedDatabase
): Promise<void> {
  const hex = randomBytes(16).toString('hex')
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
  await dependencies.query(
    provisioned.runtimeUrl,
    `INSERT INTO ${PROOF_APP_SCHEMA}.users (id) VALUES ($1::uuid)`,
    [uuid]
  )
  const rows = await dependencies.query(
    provisioned.runtimeUrl,
    `SELECT count(*)::int AS count FROM ${PROOF_APP_SCHEMA}.users WHERE id = $1::uuid`,
    [uuid]
  )
  if (Number(firstValue(rows, 'count')) !== 1) {
    throw new Error('the runtime role did not read back the row it wrote')
  }
  await dependencies.query(
    provisioned.runtimeUrl,
    `DELETE FROM ${PROOF_APP_SCHEMA}.users WHERE id = $1::uuid`,
    [uuid]
  )
}

/**
 * Runs the merged auth schema initializer: it must apply the provider tables
 * once, and a replay must change nothing.
 */
async function proveAuthSchemaInitialization(
  dependencies: DisposableProofDependencies,
  provisioned: ProvisionedDatabase,
  options: DisposableProofOptions,
  connection: { readonly authMigrationUrl: string }
): Promise<{ applied: boolean; created: readonly string[]; replayApplied: boolean }> {
  assertLoopbackTlsUrl(connection.authMigrationUrl, 'AUTH_MIGRATION_DATABASE_URL', 'verify-full')
  const environment: Record<string, string | undefined> = {
    AUTH_MIGRATION_DATABASE_URL: connection.authMigrationUrl,
    AUTH_BASE_URL: options.authBaseUrl,
    AUTH_SECRET: options.authSecret,
    AUTH_TRUSTED_ORIGINS: options.authTrustedOrigin,
    AUTH_SECURE_COOKIES: 'true',
    AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
  }

  const applied = await dependencies.applyAuthSchema(environment)
  if (applied.applied !== true) {
    throw new Error('the auth schema initializer did not apply the provider tables')
  }
  const created = applied.before.create.toSorted()
  if (JSON.stringify(created) !== JSON.stringify(EXPECTED_AUTH_TABLES.toSorted())) {
    throw new Error('the auth schema initializer did not create the provider tables')
  }
  if (!applied.after || applied.after.create.length > 0 || applied.after.add.length > 0) {
    throw new Error('the auth schema initializer left pending work after applying')
  }

  const replay = await dependencies.applyAuthSchema(environment)
  if (replay.applied !== false) {
    throw new Error('replaying the auth schema initializer was not a no-op')
  }
  if (replay.before.create.length > 0 || replay.before.add.length > 0) {
    throw new Error('replaying the auth schema initializer found pending work')
  }

  await expectRefused(
    dependencies,
    provisioned.runtimeUrl,
    `CREATE TABLE ${options.authSchema}.runtime_ddl_probe (id integer)`,
    'the runtime role created an object in the auth schema'
  )

  return { applied: applied.applied, created, replayApplied: replay.applied }
}
