import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// Builds both hosts must already exist:
//   apps/web/dist (this repository, TanStack Start) and the baseline checkout's
//   apps/web/.open-next (Next/OpenNext) from the commit under comparison.
const start = fileURLToPath(new URL('.', import.meta.url))
const web = resolve(start, '..')
const root = resolve(web, '../..')
const baselineRoot = process.env.ADEA_BASELINE_ROOT
if (!baselineRoot) throw new Error('Set ADEA_BASELINE_ROOT to a built Next checkout')
if (process.platform === 'win32') throw new Error('Local Worker checks require macOS or Linux')

const baselineWeb = resolve(baselineRoot, 'apps/web')
await mkdir(resolve(start, '.checks'), { recursive: true })
const evidence = await mkdtemp(resolve(start, '.checks/comparison-'))
const project = `adea-compare-${process.pid}`
const workers = []
const environment = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'CI', 'PLAYWRIGHT_BROWSERS_PATH']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
)
environment.WRANGLER_SEND_METRICS = 'false'

async function availablePort() {
  const server = createServer()
  await new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', ok)
  })
  const port = server.address().port
  await new Promise((ok, fail) => server.close((error) => (error ? fail(error) : ok())))
  return port
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
function startWorker(config, port, inspector, cwd) {
  const log = createWriteStream(resolve(evidence, `worker-${port}.log`))
  const child = spawn(
    'bun',
    [
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
    ],
    { cwd, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.on('error', (error) => log.write(String(error)))
  workers.push(child)
  return child
}
function localHttps(url, method = 'GET') {
  assert.equal(new URL(url).hostname, '127.0.0.1')
  return new Promise((ok, fail) => {
    const request = httpsRequest(url, { method, rejectUnauthorized: false }, (response) => {
      response.resume()
      response.once('end', () => ok({ status: response.statusCode }))
    })
    request.setTimeout(10_000, () => request.destroy(new Error('Local request timed out')))
    request.once('error', fail)
    request.end()
  })
}
async function waitFor(probe, label) {
  const deadline = Date.now() + 120_000
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

const databasePort = await availablePort()
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

// One shared database serves both hosts so guest sessions are comparable.
let databaseStarted = false
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

  const hosts = {}
  for (const name of ['baseline', 'candidate']) {
    const port = await availablePort()
    const inspector = await availablePort()
    const origin = `https://127.0.0.1:${port}`
    let main
    let cwd
    let assets
    if (name === 'baseline') {
      main = resolve(baselineWeb, '.open-next/worker.js')
      assets = resolve(baselineWeb, '.open-next/assets')
      cwd = baselineWeb
    } else {
      const built = JSON.parse(
        (await import('node:fs')).readFileSync(resolve(web, 'dist/server/wrangler.json'), 'utf8')
      )
      main = resolve(web, 'dist/server', built.main)
      assets = resolve(web, 'dist/server', built.assets.directory)
      cwd = web
    }
    const config = resolve(evidence, `${name}.json`)
    await writeFile(
      config,
      JSON.stringify(
        {
          ...compatibility,
          name: `${project}-${name}`,
          main,
          // OpenNext's serialized theme scripts need esbuild name helpers off.
          ...(name === 'baseline' ? { keep_names: false } : {}),
          assets: { binding: 'ASSETS', directory: assets },
          hyperdrive: [
            {
              binding: 'HYPERDRIVE',
              id: 'local',
              localConnectionString: databaseUrl('agent_hq_local_app'),
            },
          ],
          vars: { DATABASE_URL: databaseEnvironment.DATABASE_URL, AUTH_TRUSTED_ORIGINS: origin },
        },
        null,
        2
      )
    )
    startWorker(config, port, inspector, cwd)
    await waitFor(
      async () => (await localHttps(`${origin}/?view=chat&scene=home`)).status === 200,
      name
    )
    hosts[name] = origin
  }

  const output = resolve(evidence, 'comparison')
  await run(
    'bun',
    [
      'run',
      'start:compare',
      '--baseline-url',
      hosts.baseline,
      '--candidate-url',
      hosts.candidate,
      '--runs',
      '5',
      '--output',
      output,
    ],
    web
  )
  console.log(JSON.stringify({ evidence }))
} finally {
  for (const worker of workers) stopWorker(worker)
  await delay(500)
  if (databaseStarted) {
    await run(
      'docker',
      ['compose', '-p', project, '-f', 'compose.yml', 'down', '--volumes'],
      root,
      databaseEnvironment
    )
  }
}
