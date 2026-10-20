// Acceptance for the built auth Worker, run through the repository's pinned Miniflare
// instead of `wrangler dev`. Two artifacts are accepted, and each run names one:
//   - the fixture build (default): recording transport and loopback outbox, run as
//     `--prepare` then `--fixture-exercise` with the required email verification;
//   - the ordinary production build (`--production`): no fixture marker, no outbox, run as
//     `--prepare` then `--exercise` under a local-test-only lifecycle configuration with
//     verification explicitly off. The application default (required, no transport) is
//     not exercised and is not claimed as qualified.
// The test file it drives (packages/auth/tests/integration/better-auth-worker-local.mjs)
// is unchanged. The Worker is served on an HTTPS entry socket with the loopback
// certificate, so there is no ProxyWorker hop. Neither artifact is production
// qualification of the ProxyWorker path, and every process and socket is reaped before
// the run exits.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer as createHttpServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Miniflare } from 'miniflare'
import { disposeBounded, startBounded, withDeadline } from './miniflare-bounds.mjs'
import { createLoopbackCertificate } from './loopback-tls.mjs'
import { findFixtureMarkers } from './auth-fixture-markers.mjs'
import { checkMarkers, selectArtifact, workerVariables } from './auth-artifact-selection.mjs'

const start = fileURLToPath(new URL('.', import.meta.url))
const web = resolve(start, '..')
const root = resolve(web, '../..')
const productionDist = resolve(web, 'dist')
if (process.platform === 'win32') throw new Error('Local Worker checks require macOS or Linux')

const postgresPort = process.env.ADEA_AUTH_WORKER_POSTGRES_PORT
assert.match(
  postgresPort ?? '',
  /^\d{2,5}$/,
  'ADEA_AUTH_WORKER_POSTGRES_PORT must name a loopback PostgreSQL port'
)
const databaseUrl = (role) =>
  `postgresql://${role}:${role}@127.0.0.1:${postgresPort}/agent_hq?sslmode=disable`
const artifact = selectArtifact({
  args: process.argv.slice(2),
  env: process.env,
  productionDir: productionDist,
  defaultFixtureDir: resolve(start, '.checks/auth-fixture/dist'),
})
const production = artifact.production
const artifactKind = artifact.kind
const artifactDir = artifact.directory

// Reads the built output before any process or socket exists. A missing or malformed
// build is refused here. The fixture run needs fixture markers; the production run
// refuses any output that carries one, so each run only ever accepts its own artifact.
async function loadArtifact(directory) {
  let built
  try {
    built = JSON.parse(await readFile(resolve(directory, 'server/wrangler.json'), 'utf8'))
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'is malformed' : 'is missing'
    throw new Error(
      `${artifactKind} output ${reason}: server/wrangler.json under ${directory}; build it first`,
      { cause: error }
    )
  }
  if (
    typeof built.main !== 'string' ||
    typeof built.compatibility_date !== 'string' ||
    typeof built.assets?.directory !== 'string' ||
    !Array.isArray(built.compatibility_flags)
  )
    throw new Error(`${artifactKind} output is malformed: server/wrangler.json under ${directory}`)
  checkMarkers({
    kind: artifactKind,
    markerCount: (await findFixtureMarkers(directory)).length,
    directory,
  })
  return built
}

// Test processes inherit no production credentials or database URLs.
const environment = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'CI']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
)

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => controller.abort(new Error(`interrupted by ${signal}`)))

// Test-runner child processes are recorded here and reaped during cleanup.
const groupLeaders = []
const ports = new Set()
const miniflares = []
let outbox

async function availablePort() {
  while (true) {
    const server = createServer()
    await new Promise((ok, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', ok)
    })
    const port = server.address().port
    await new Promise((ok, fail) => server.close((error) => (error ? fail(error) : ok())))
    if (!ports.has(port)) {
      ports.add(port)
      return port
    }
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function waitUntil(predicate, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(100)
  }
  return predicate()
}

// SIGTERM the whole process group, allow a bounded grace period, then SIGKILL
// whatever survives. Failing to kill the group is an error, never a silent leak.
async function reap(child, { graceMs = 5_000, killMs = 3_000 } = {}) {
  if (!child.pid || !groupAlive(child.pid)) return
  signalGroup(child.pid, 'SIGTERM')
  if (await waitUntil(() => !groupAlive(child.pid), graceMs)) return
  signalGroup(child.pid, 'SIGKILL')
  if (!(await waitUntil(() => !groupAlive(child.pid), killMs)))
    throw new Error(`process group ${child.pid} survived SIGKILL`)
}

function run(command, args, cwd = root, env = environment) {
  controller.signal.throwIfAborted()
  return new Promise((ok, fail) => {
    // Detached so the group can be reaped as a unit; the terminal's SIGINT reaches
    // this harness only, and cleanup takes the children down.
    const child = spawn(command, args, { cwd, env, detached: true, stdio: 'inherit' })
    groupLeaders.push(child)
    controller.signal.addEventListener('abort', () => void reap(child), { once: true })
    child.once('error', fail)
    child.once('exit', (code, signal) =>
      code === 0 ? ok() : fail(new Error(`${command} ${args.join(' ')} exited ${code ?? signal}`))
    )
  })
}

// The loopback outbox records what the fixture transport hands over. It is part of
// this harness only; the built Worker never contains it.
const messages = []
function startOutbox() {
  return new Promise((ok, fail) => {
    const server = createHttpServer((request, response) => {
      if (request.method === 'POST' && request.url === '/record') {
        const chunks = []
        request.on('data', (chunk) => chunks.push(chunk))
        request.on('end', () => {
          messages.push({ ...JSON.parse(Buffer.concat(chunks).toString('utf8')), at: Date.now() })
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"recorded":true}')
        })
        return
      }
      if (request.method === 'GET' && request.url === '/messages') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(messages))
        return
      }
      response.writeHead(404)
      response.end()
    })
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => ok(server))
  })
}

function closeOutbox(server) {
  return new Promise((ok, fail) => {
    server.close((error) => (error ? fail(error) : ok()))
    server.closeAllConnections()
  })
}

// Starts the built Worker in-process through Miniflare. The entry socket is HTTPS on
// the loopback port, so requests reach the Worker without a proxy in between.
async function startMiniflare({ built, fixtureServer, port, inspector, tls, vars, hyperdrive }) {
  // Instance options (entry socket, TLS, inspector) are top level. The Worker is one
  // entry of `workers`, whose `config` carries its modules, assets and bindings: vars
  // as text bindings, the local PostgreSQL URL as a hyperdrive binding.
  const modules = await moduleManifest(fixtureServer)
  const env = {
    HYPERDRIVE: { type: 'hyperdrive', id: 'local', dev: { connectionString: hyperdrive } },
  }
  for (const [name, value] of Object.entries(vars)) env[name] = { type: 'text', value }
  const mf = new Miniflare({
    host: '127.0.0.1',
    port,
    https: true,
    httpsKey: await readFile(tls.keyPath, 'utf8'),
    httpsCert: await readFile(tls.certPath, 'utf8'),
    inspectorPort: inspector,
    workers: [
      {
        config: {
          name: 'adea-auth-fixture-host',
          compatibilityDate: built.compatibility_date,
          compatibilityFlags: built.compatibility_flags,
          manifest: { mainModule: built.main, modulesRoot: fixtureServer, modules },
          assets: {
            directory: resolve(fixtureServer, built.assets.directory),
            notFoundHandling: built.assets.not_found_handling ?? 'none',
            runWorkerFirst: built.assets.run_worker_first ?? true,
            hasUserWorker: true,
          },
          env,
        },
      },
    ],
  })
  miniflares.push(mf)
  await startBounded(mf, { ms: 60_000, signal: controller.signal })
  return mf
}

// Every JavaScript module under the fixture's server directory, keyed by its path
// relative to that directory, which is what the built entry imports by.
async function moduleManifest(directory) {
  const modules = {}
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.m?js$/.test(entry.name)) continue
    const absolute = resolve(entry.parentPath, entry.name)
    const key = absolute
      .slice(directory.length + 1)
      .split('\\')
      .join('/')
    modules[key] = { type: 'esm', contents: await readFile(absolute, 'utf8') }
  }
  return modules
}

function localHttps(url, ca) {
  assert.equal(new URL(url).hostname, '127.0.0.1')
  return new Promise((ok, fail) => {
    const request = httpsRequest(url, { method: 'GET', ca }, (response) => {
      response.resume()
      response.once('end', () => ok({ status: response.statusCode }))
    })
    request.setTimeout(10_000, () => request.destroy(new Error('Local request timed out')))
    request.once('error', fail)
    request.end()
  })
}

async function waitFor(probe, label, evidence) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted()
    try {
      if (await probe()) return
    } catch {}
    await delay(250, undefined, { signal: controller.signal })
  }
  throw new Error(`${label} did not become ready; inspect ${evidence}`)
}

// Stops every started process, the Miniflare instances and the outbox. Failures are
// collected, so one stuck process cannot leave the others running.
async function releaseResources() {
  const failures = []
  const results = await Promise.allSettled(groupLeaders.map((child) => reap(child)))
  for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
  for (const mf of miniflares) {
    try {
      await disposeBounded(mf, { ms: 15_000 })
    } catch (error) {
      failures.push(error)
    }
  }
  if (outbox) {
    try {
      await withDeadline(closeOutbox(outbox), 10_000, 'outbox close')
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'fixture harness cleanup failed')
}

// Records what this run ran, so an evidence directory names its own inputs: the harness
// file, the fixture artifact it served, the Miniflare version, the head and the Node
// version. Written before any process starts, so a failed run still has it.
async function writeDiagnostics(directory) {
  // Every file under the fixture dist, sorted by path, so the digest covers each module,
  // asset and config byte the harness can serve, not only the entry.
  const tree = createHash('sha256')
  const files = (await readdir(artifactDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .map((absolute) =>
      absolute
        .slice(artifactDir.length + 1)
        .split('\\')
        .join('/')
    )
    .toSorted()
  for (const relative of files) {
    tree.update(relative).update('\0')
    tree.update(await readFile(resolve(artifactDir, relative)))
    tree.update('\0')
  }
  const harness = createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex')
  const head = await new Promise((ok) =>
    execFile('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5_000 }, (error, stdout) =>
      ok(error ? 'unknown' : stdout.trim())
    )
  )
  await writeFile(
    resolve(directory, 'diagnostics.json'),
    JSON.stringify(
      {
        head,
        harnessSha256: harness,
        artifact: artifactKind,
        artifactTreeSha256: tree.digest('hex'),
        artifactTreeScope: `${files.length} files under the ${artifactKind} output, sorted by path, each as path, NUL, bytes, NUL`,
        artifactDir,
        miniflare: createRequire(import.meta.url)('miniflare/package.json').version,
        node: process.version,
      },
      null,
      2
    )
  )
}

async function acceptArtifact() {
  const built = await loadArtifact(artifactDir)
  await mkdir(resolve(start, '.checks'), { recursive: true })
  const evidence = await mkdtemp(resolve(start, `.checks/${artifactKind}-miniflare-`))
  await writeDiagnostics(evidence)
  const tls = createLoopbackCertificate(evidence)
  const authSchema = `auth_worker_${randomUUID().replaceAll('-', '')}`
  const workerApplicationName = `adea_auth_worker_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const authSecret = 'local-fixture-auth-secret-for-test-only-1234567'
  const [hostPort, inspector] = await Promise.all([availablePort(), availablePort()])
  const baseURL = `https://127.0.0.1:${hostPort}`
  // Only the fixture run owns an outbox; the production run has no recording transport.
  outbox = production ? undefined : await startOutbox()
  const outboxUrl = outbox ? `http://127.0.0.1:${outbox.address().port}` : undefined

  const authDatabase = new URL(databaseUrl('agent_hq_local_app'))
  authDatabase.searchParams.set('options', `-c search_path=${authSchema}`)
  authDatabase.searchParams.set('application_name', workerApplicationName)
  const authDatabaseUrl = authDatabase.toString()
  const fixtureServer = resolve(artifactDir, 'server')
  // The fixture Worker must reach the loopback outbox, so the fixture run uses the
  // built config's flags as they are and this harness never adds or removes one. The
  // production run is a local-test-only lifecycle configuration: verification is set to
  // false explicitly, because the lifecycle assertions need a session at signup. The
  // application default (required, no transport) is not exercised here and is not
  // claimed as qualified. Neither an outbox nor a fixture variable reaches its Worker.
  const vars = workerVariables({
    kind: artifactKind,
    baseURL,
    databaseUrl: authDatabaseUrl,
    secret: authSecret,
    outboxUrl,
  })

  const authWorkerTest = 'packages/auth/tests/integration/better-auth-worker-local.mjs'
  const authTestEnvironment = {
    ...environment,
    AUTH_BASE_URL: baseURL,
    AUTH_DATABASE_URL: authDatabaseUrl,
    AUTH_SECRET: authSecret,
    AUTH_SECURE_COOKIES: 'true',
    AUTH_TRUSTED_ORIGINS: baseURL,
    AUTH_POSTGRES_TEST_URL: databaseUrl('agent_hq_local_migration'),
    AUTH_TEST_SCHEMA: authSchema,
    AUTH_WORKER_APPLICATION_NAME: workerApplicationName,
    ...(production
      ? {}
      : { AUTH_EMAIL_VERIFICATION_REQUIRED: 'true', ADEA_AUTH_FIXTURE_OUTBOX_URL: outboxUrl }),
  }

  await run(
    'bun',
    ['--conditions=react-server', 'run', authWorkerTest, '--prepare'],
    root,
    authTestEnvironment
  )
  await startMiniflare({
    built,
    fixtureServer,
    port: hostPort,
    inspector,
    tls,
    vars,
    hyperdrive: databaseUrl('agent_hq_local_app'),
  })
  await waitFor(
    async () => (await localHttps(baseURL, tls.certificate)).status === 200,
    `${artifactKind} host (Miniflare)`,
    evidence
  )
  await run(
    'bun',
    [
      '--conditions=react-server',
      'run',
      authWorkerTest,
      production ? '--exercise' : '--fixture-exercise',
    ],
    root,
    { ...authTestEnvironment, ADEA_AUTH_WORKER_URL: baseURL, ADEA_AUTH_WORKER_CA: tls.certPath }
  )
  const report = {
    harness: 'miniflare',
    artifact: artifactKind,
    artifactDir,
    outboxMessagesRecorded: outbox ? messages.length : null,
    node: process.version,
    evidence,
  }
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}

let outcome
try {
  await acceptArtifact()
} catch (error) {
  // A reaped child reports its own exit; the interruption is the real cause.
  outcome = controller.signal.aborted ? controller.signal.reason : error
}
let cleanup
try {
  await releaseResources()
} catch (error) {
  cleanup = error
}
if (outcome) {
  if (cleanup) console.error(cleanup)
  throw outcome
}
if (cleanup) throw cleanup
