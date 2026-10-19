// Fixture-only acceptance for the built auth Worker. It runs the fixture build
// (ADEA_AUTH_FIXTURE_BUILD=1), whose verification and reset messages go to a
// loopback outbox owned by this process. It never runs against production
// configuration, and it creates nothing outside its own schema and outbox.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createLoopbackCertificate } from './loopback-tls.mjs'
import { writeLocalWorkerConfig } from './local-worker-config.mjs'

const start = fileURLToPath(new URL('.', import.meta.url))
const web = resolve(start, '..')
const root = resolve(web, '../..')
if (process.platform === 'win32') throw new Error('Local Worker checks require macOS or Linux')

const postgresPort = process.env.ADEA_AUTH_WORKER_POSTGRES_PORT
assert.match(
  postgresPort ?? '',
  /^\d{2,5}$/,
  'ADEA_AUTH_WORKER_POSTGRES_PORT must name a loopback PostgreSQL port'
)
const fixtureDist = resolve(
  process.env.ADEA_AUTH_FIXTURE_DIST ?? resolve(start, '.checks/fixture-build/dist')
)

await mkdir(resolve(start, '.checks'), { recursive: true })
const evidence = await mkdtemp(resolve(start, '.checks/fixture-'))
const tls = createLoopbackCertificate(evidence)
const authSchema = `auth_worker_${randomUUID().replaceAll('-', '')}`
const workerApplicationName = `adea_auth_worker_${randomUUID().replaceAll('-', '').slice(0, 12)}`
const authSecret = 'local-fixture-auth-secret-for-test-only-1234567'
const workers = []
const ports = new Set()
// Test processes inherit no production credentials or database URLs.
const environment = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'CI']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
)
Object.assign(environment, { WRANGLER_SEND_METRICS: 'false' })

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

function run(command, args, cwd = root, env = environment) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.once('error', fail)
    child.once('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`${command} ${args.join(' ')} exited ${code}`))
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

function startWorker(config, port, inspector) {
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
  workers.push(child)
  return child
}

function stopWorker(child) {
  if (!child.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function localHttps(url) {
  assert.equal(new URL(url).hostname, '127.0.0.1')
  return new Promise((ok, fail) => {
    const request = httpsRequest(url, { method: 'GET', ca: tls.certificate }, (response) => {
      response.resume()
      response.once('end', () => ok({ status: response.statusCode }))
    })
    request.setTimeout(10_000, () => request.destroy(new Error('Local request timed out')))
    request.once('error', fail)
    request.end()
  })
}

async function waitFor(probe, label) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      if (await probe()) return
    } catch {}
    await delay(250)
  }
  throw new Error(`${label} did not become ready; inspect ${evidence}`)
}

const databaseUrl = (role) =>
  `postgresql://${role}:${role}@127.0.0.1:${postgresPort}/agent_hq?sslmode=disable`
const [hostPort, inspector] = await Promise.all([availablePort(), availablePort()])
const baseURL = `https://127.0.0.1:${hostPort}`
const outbox = await startOutbox()
const outboxUrl = `http://127.0.0.1:${outbox.address().port}`

const built = JSON.parse(await readFile(resolve(fixtureDist, 'server/wrangler.json'), 'utf8'))
const authDatabase = new URL(databaseUrl('agent_hq_local_app'))
authDatabase.searchParams.set('options', `-c search_path=${authSchema}`)
authDatabase.searchParams.set('application_name', workerApplicationName)
const authDatabaseUrl = authDatabase.toString()
// The fixture Worker must reach the loopback outbox, which the production flag
// `global_fetch_strictly_public` refuses. Only this fixture config drops it.
const host = {
  compatibility_date: built.compatibility_date,
  compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
  name: 'adea-auth-fixture-host',
  main: resolve(dirname(resolve(fixtureDist, 'server/wrangler.json')), built.main),
  rules: built.rules,
  no_bundle: true,
  assets: {
    ...built.assets,
    directory: resolve(
      dirname(resolve(fixtureDist, 'server/wrangler.json')),
      built.assets.directory
    ),
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

try {
  await run(
    'bun',
    ['--conditions=react-server', 'run', authWorkerTest, '--prepare'],
    root,
    authTestEnvironment
  )
  startWorker(hostConfig, hostPort, inspector)
  await waitFor(async () => (await localHttps(baseURL)).status === 200, 'Fixture host')
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
} finally {
  for (const worker of workers) stopWorker(worker)
  await delay(500)
  outbox.close()
}
