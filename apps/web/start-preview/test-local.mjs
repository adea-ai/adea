import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const preview = fileURLToPath(new URL('.', import.meta.url))
const web = resolve(preview, '..')
const root = resolve(web, '../..')
if (process.platform === 'win32') throw new Error('Local Worker checks require macOS or Linux')
await mkdir(resolve(preview, '.checks'), { recursive: true })
const evidence = await mkdtemp(resolve(preview, '.checks/local-'))
const project = `adea-start-check-${process.pid}`
const workers = []
// Do not inherit production service credentials or database URLs into test processes.
const environment = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'CI', 'PLAYWRIGHT_BROWSERS_PATH']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
)
Object.assign(environment, { WRANGLER_SEND_METRICS: 'false', NEXT_TELEMETRY_DISABLED: '1' })
let databaseStarted = false
const ports = new Set()
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
function startWorker(config, port, inspector, secure = false) {
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
  ]
  if (secure) args.push('--local-protocol', 'https')
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
function localHttps(url, method = 'GET') {
  // This helper is only called with the loopback URLs allocated by this process.
  assert.equal(new URL(url).hostname, '127.0.0.1')
  return new Promise((ok, fail) => {
    const request = httpsRequest(url, { method, rejectUnauthorized: false }, (response) => {
      response.resume()
      response.once('end', () => ok({ status: response.statusCode, headers: response.headers }))
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
function stopWorker(child) {
  if (!child.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
const [databasePort, backendPort, gatewayPort, backendInspector, gatewayInspector] =
  await Promise.all(Array.from({ length: 5 }, availablePort))
const baseURL = `https://127.0.0.1:${gatewayPort}`
const backendURL = `https://127.0.0.1:${backendPort}`
const generatedPath = resolve(preview, 'dist/server/wrangler.json')
const built = JSON.parse(await readFile(generatedPath, 'utf8'))
await readFile(resolve(web, '.open-next/worker.js'))
const legacyName = `${project}-backend`
const compatibility = {
  compatibility_date: '2026-08-01',
  compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
}
const databaseUrl = (role) =>
  `postgresql://${role}:${role}@127.0.0.1:${databasePort}/agent_hq?sslmode=disable`
const databaseEnvironment = {
  ...environment,
  DATABASE_URL: databaseUrl('agent_hq_local_app'),
  DATABASE_URL_UNPOOLED: databaseUrl('agent_hq_local_app'),
  DATABASE_MIGRATION_URL: databaseUrl('agent_hq_local_migration'),
  ADEA_POSTGRES_PORT: String(databasePort),
}
const legacy = {
  ...compatibility,
  name: legacyName,
  // Prevent esbuild name helpers inside serialized next-themes scripts.
  keep_names: false,
  main: resolve(web, '.open-next/worker.js'),
  assets: { binding: 'ASSETS', directory: resolve(web, '.open-next/assets') },
  vars: { DATABASE_URL: databaseEnvironment.DATABASE_URL, AUTH_TRUSTED_ORIGINS: baseURL },
}
const gateway = {
  ...compatibility,
  name: `${project}-gateway`,
  main: resolve(dirname(generatedPath), built.main),
  rules: built.rules,
  no_bundle: true,
  assets: { ...built.assets, directory: resolve(dirname(generatedPath), built.assets.directory) },
  services: [{ binding: 'ADEA_LEGACY_BACKEND', service: legacyName }],
}
const backendConfig = resolve(evidence, 'backend.json')
const gatewayConfig = resolve(evidence, 'gateway.json')
await writeFile(backendConfig, JSON.stringify(legacy, null, 2))
await writeFile(gatewayConfig, JSON.stringify(gateway, null, 2))
try {
  databaseStarted = true
  await run(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      'compose.yml',
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '60',
      'postgres',
    ],
    root,
    databaseEnvironment
  )
  await run('bun', ['run', '--cwd', 'packages/db', 'db:verify'], root, databaseEnvironment)
  const backend = startWorker(backendConfig, backendPort, backendInspector, true)
  const gateStatus = async () => (await localHttps(`${backendURL}/api/web-entry`)).status
  await waitFor(async () => (await gateStatus()) === 200, 'Legacy entry gate')
  startWorker(gatewayConfig, gatewayPort, gatewayInspector, true)
  await waitFor(async () => (await localHttps(baseURL)).status === 200, 'Start gateway')
  await run('bun', ['run', 'start:e2e'], web, {
    ...environment,
    ADEA_START_PREVIEW_URL: baseURL,
    ADEA_START_ISOLATED_TEST_TARGET: '1',
  })
  if (process.argv.includes('--compare')) {
    await run(
      'bun',
      [
        'run',
        'start:compare',
        '--next-url',
        backendURL,
        '--start-url',
        baseURL,
        '--runs',
        '5',
        '--output',
        resolve(evidence, 'comparison'),
      ],
      web
    )
  }
  // Exercise the actual Next policy and gateway after enabling the account allowlist.
  legacy.vars.ADEA_ALLOWED_EMAILS = 'allowed@example.test'
  await writeFile(backendConfig, JSON.stringify(legacy, null, 2))
  await waitFor(async () => (await gateStatus()) === 401, 'Restricted legacy gate')
  const restricted = await localHttps(baseURL)
  assert.equal(restricted.status, 307)
  assert.equal(restricted.headers.location, '/auth/sign-in')
  assert.equal((await localHttps(`${baseURL}/api/workspaces/bootstrap`, 'POST')).status, 401)
  delete legacy.vars.ADEA_ALLOWED_EMAILS
  await writeFile(backendConfig, JSON.stringify(legacy, null, 2))
  await waitFor(async () => (await gateStatus()) === 200, 'Restored guest gate')
  stopWorker(backend)
  await waitFor(
    async () => (await localHttps(baseURL)).status === 503,
    'Fail-closed disconnected backend'
  )
  const report = {
    browserSuite: 'passed',
    restrictedEntry: 'passed',
    restrictedGuestApi: 'passed',
    disconnectedBackend: 'passed',
    node: process.version,
  }
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, evidence }))
} finally {
  for (const worker of workers) stopWorker(worker)
  await delay(500)
  if (databaseStarted) {
    // This project and volume were created by this process, never the user's dev database.
    await run(
      'docker',
      ['compose', '-p', project, '-f', 'compose.yml', 'down', '--volumes'],
      root,
      databaseEnvironment
    )
  }
}
