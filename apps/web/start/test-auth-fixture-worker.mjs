// Fixture-only acceptance for the built auth Worker. It consumes the fixture build
// (start/build-auth-fixture.mjs), whose verification and reset messages go to a
// loopback outbox owned by this process. It never runs against production output or
// configuration. Every process and socket it creates is reaped or closed before it
// exits, including after a failure, a missing or malformed fixture, or SIGINT/SIGTERM.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createLoopbackCertificate } from './loopback-tls.mjs'
import { writeLocalWorkerConfig } from './local-worker-config.mjs'
import { findFixtureMarkers } from './auth-fixture-markers.mjs'

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
const fixtureDist = resolve(
  process.env.ADEA_AUTH_FIXTURE_DIST ?? resolve(start, '.checks/auth-fixture/dist')
)

// Reads the fixture output before any process or socket exists. A missing, malformed
// or ordinary (marker-free) build is refused here, so nothing is started to fail later.
async function loadFixtureOutput(directory) {
  if (directory === productionDist)
    throw new Error('refusing to run the fixture acceptance against the production output')
  let built
  try {
    built = JSON.parse(await readFile(resolve(directory, 'server/wrangler.json'), 'utf8'))
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'is malformed' : 'is missing'
    throw new Error(
      `fixture output ${reason}: server/wrangler.json under ${directory}; run start:build:auth-fixture first`,
      { cause: error }
    )
  }
  if (
    typeof built.main !== 'string' ||
    typeof built.compatibility_date !== 'string' ||
    typeof built.assets?.directory !== 'string'
  )
    throw new Error(`fixture output is malformed: server/wrangler.json under ${directory}`)
  if ((await findFixtureMarkers(directory)).length === 0)
    throw new Error(`fixture output carries no fixture markers under ${directory}; refusing it`)
  return built
}

// Test processes inherit no production credentials or database URLs.
const environment = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'CI']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
)
Object.assign(environment, { WRANGLER_SEND_METRICS: 'false' })

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => controller.abort(new Error(`interrupted by ${signal}`)))

// Every process this harness starts is recorded here and reaped during cleanup,
// even after its leader has exited, because the group may still hold workerd.
const groupLeaders = []
const workers = []
const ports = new Set()
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

function startWorker(config, port, inspector, evidence, tls) {
  controller.signal.throwIfAborted()
  const log = createWriteStream(resolve(evidence, `worker-${port}.log`))
  const args = [
    'x',
    'wrangler',
    'dev',
    '--local',
    '--config',
    config,
    '--port',
    String(port),
    '--inspector-port',
    String(inspector),
    '--persist-to',
    resolve(evidence, `state-${port}`),
    '--local-protocol',
    'https',
    '--https-cert-path',
    tls.certPath,
    '--https-key-path',
    tls.keyPath,
    // Diagnostic only: ADEA_AUTH_DIAG_WORKERD=1 raises wrangler and workerd log detail.
    ...(process.env.ADEA_AUTH_DIAG_WORKERD === '1' ? ['--log-level', 'debug'] : []),
  ]
  const child = spawn('bun', args, {
    cwd: web,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.on('error', (error) => log.write(String(error)))
  groupLeaders.push(child)
  workers.push({ child, log })
  return child
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

// Stops every started process and closes the outbox. Failures are collected, so one
// stuck process cannot leave the others running.
async function releaseResources() {
  const failures = []
  const results = await Promise.allSettled(groupLeaders.map((child) => reap(child)))
  for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
  for (const { log } of workers) log.end()
  if (outbox) {
    try {
      await closeOutbox(outbox)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'fixture harness cleanup failed')
}

async function acceptFixture() {
  const built = await loadFixtureOutput(fixtureDist)
  await mkdir(resolve(start, '.checks'), { recursive: true })
  const evidence = await mkdtemp(resolve(start, '.checks/fixture-'))
  const tls = createLoopbackCertificate(evidence)
  const authSchema = `auth_worker_${randomUUID().replaceAll('-', '')}`
  const workerApplicationName = `adea_auth_worker_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const authSecret = 'local-fixture-auth-secret-for-test-only-1234567'
  const [hostPort, inspector] = await Promise.all([availablePort(), availablePort()])
  const baseURL = `https://127.0.0.1:${hostPort}`
  outbox = await startOutbox()
  const outboxUrl = `http://127.0.0.1:${outbox.address().port}`

  const authDatabase = new URL(databaseUrl('agent_hq_local_app'))
  authDatabase.searchParams.set('options', `-c search_path=${authSchema}`)
  authDatabase.searchParams.set('application_name', workerApplicationName)
  const authDatabaseUrl = authDatabase.toString()
  const fixtureServer = resolve(fixtureDist, 'server')
  // The fixture Worker must reach the loopback outbox, which the production flag
  // `global_fetch_strictly_public` refuses. Only this fixture config drops it.
  const host = {
    compatibility_date: built.compatibility_date,
    compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
    name: 'adea-auth-fixture-host',
    main: resolve(fixtureServer, built.main),
    rules: built.rules,
    no_bundle: true,
    assets: {
      ...built.assets,
      directory: resolve(fixtureServer, built.assets.directory),
    },
    hyperdrive: [
      {
        binding: 'HYPERDRIVE',
        id: 'local',
        localConnectionString: databaseUrl('agent_hq_local_app'),
      },
    ],
    vars: {
      AUTH_BASE_URL: baseURL,
      AUTH_DATABASE_URL: authDatabaseUrl,
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
      AUTH_SECRET: authSecret,
      AUTH_SECURE_COOKIES: 'true',
      AUTH_TRUSTED_ORIGINS: baseURL,
      ADEA_AUTH_FIXTURE_OUTBOX_URL: outboxUrl,
    },
  }
  const hostConfig = resolve(evidence, 'host.json')
  await writeLocalWorkerConfig(hostConfig, host)

  const authWorkerTest = 'packages/auth/tests/integration/better-auth-worker-local.mjs'
  const authTestEnvironment = {
    ...environment,
    AUTH_BASE_URL: baseURL,
    AUTH_DATABASE_URL: authDatabaseUrl,
    AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
    AUTH_SECRET: authSecret,
    AUTH_SECURE_COOKIES: 'true',
    AUTH_TRUSTED_ORIGINS: baseURL,
    AUTH_POSTGRES_TEST_URL: databaseUrl('agent_hq_local_migration'),
    AUTH_TEST_SCHEMA: authSchema,
    AUTH_WORKER_APPLICATION_NAME: workerApplicationName,
    ADEA_AUTH_FIXTURE_OUTBOX_URL: outboxUrl,
  }

  await run(
    'bun',
    ['--conditions=react-server', 'run', authWorkerTest, '--prepare'],
    root,
    authTestEnvironment
  )
  startWorker(hostConfig, hostPort, inspector, evidence, tls)
  await waitFor(
    async () => (await localHttps(baseURL, tls.certificate)).status === 200,
    'Fixture host',
    evidence
  )
  await run(
    'bun',
    ['--conditions=react-server', 'run', authWorkerTest, '--fixture-exercise'],
    root,
    { ...authTestEnvironment, ADEA_AUTH_WORKER_URL: baseURL, ADEA_AUTH_WORKER_CA: tls.certPath }
  )
  const report = {
    fixtureBuild: fixtureDist,
    outboxMessagesRecorded: messages.length,
    node: process.version,
    evidence,
  }
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}

let outcome
try {
  await acceptFixture()
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
