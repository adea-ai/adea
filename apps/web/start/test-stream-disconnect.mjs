import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  captureCommand,
  composePostgresImage,
  runWithPullFallback,
  withComposeImage,
} from '../../../scripts/docker-pull-backoff.mjs'
import { createLoopbackCertificate } from './loopback-tls.mjs'
import { disconnectStream } from './stream-disconnect-client.mjs'

const start = fileURLToPath(new URL('.', import.meta.url))
const web = resolve(start, '..')
const root = resolve(web, '../..')
assert.notEqual(process.platform, 'win32', 'Native local Worker checks require macOS or Linux')
await mkdir(resolve(start, '.checks'), { recursive: true })
const evidence = await mkdtemp(resolve(start, '.checks/local-disconnect-'))
const tls = createLoopbackCertificate(evidence)
const project = `adea-disconnect-check-${process.pid}`
const environment = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'CI']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
)
environment.WRANGLER_SEND_METRICS = 'false'
// Resolve the native runtime through the locked Wrangler dependency, never a global binary.
const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const miniflareRequire = createRequire(wranglerRequire.resolve('miniflare'))
const { default: binary, version: workerdVersion } = miniflareRequire('workerd')
const builtPath = resolve(web, 'dist/server/wrangler.json')
const built = JSON.parse(await readFile(builtPath, 'utf8'))
assert(
  built.compatibility_flags.includes('enable_request_signal'),
  'Build must preserve the production incoming-request signal flag'
)
const artifact = dirname(resolve(dirname(builtPath), built.main))
await cp(artifact, resolve(evidence, 'artifact'), { recursive: true })
const modules = []
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      await collect(resolve(directory, entry.name), `${prefix}${entry.name}/`)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))
      modules.push(`${prefix}${entry.name}`)
  }
}
await collect(resolve(evidence, 'artifact'))
const main = built.main.split('/').at(-1)
assert(modules.includes(main), 'Built Worker entry must be in the isolated module copy')
// A test-only wrapper observes the original signal without changing response delivery.
await writeFile(
  resolve(evidence, 'wrapper.js'),
  `import application from './artifact/${main}';
export default { fetch(request, env, context) {
 if(request.headers.has('x-disconnect-case'))request.signal.addEventListener('abort',()=>console.log('DISCONNECT_ABORT '+Date.now()),{once:true});
 return application.fetch(request,env,context);
} };\n`
)
const allocate = async () => {
  const server = createServer()
  await new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', ok)
  })
  const port = server.address().port
  await new Promise((ok, fail) => server.close((error) => (error ? fail(error) : ok())))
  return port
}
const databasePort = await allocate()
const url = (role) =>
  `postgresql://${role}:${role}@127.0.0.1:${databasePort}/agent_hq?sslmode=disable`
const databaseEnvironment = {
  ...environment,
  DATABASE_URL: url('agent_hq_local_app'),
  DATABASE_URL_UNPOOLED: url('agent_hq_local_app'),
  DATABASE_MIGRATION_URL: url('agent_hq_local_migration'),
  ADEA_POSTGRES_PORT: String(databasePort),
}
const command = async (program, args, env = environment) => {
  const result = await captureCommand(program, args, { cwd: root, env })
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr || result.stdout}`)
  return `${result.stdout}${result.stderr}`
}
const compose = ['compose', '-p', project, '-f', 'compose.yml']
let databaseStarted = false
let worker
const stopWorker = async () => {
  if (!worker) return
  const child = worker
  worker = undefined
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((ok) => child.once('exit', ok))
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    await exited
  }
}
let container
const postgresLogs = () => command('docker', ['logs', container])
const statementCount = (log) =>
  [...log.matchAll(/(?:statement:|execute [^:\r\n]+:)\s*(\w+)/gi)].length
const reports = []
try {
  databaseStarted = true
  const up = await runWithPullFallback(
    (image) =>
      captureCommand(
        'docker',
        [...compose, 'up', '-d', '--wait', '--wait-timeout', '60', 'postgres'],
        { cwd: root, env: withComposeImage(databaseEnvironment, image) }
      ),
    composePostgresImage(root)
  )
  assert.equal(up.status, 0, up.stderr)
  await command('bun', ['run', '--cwd', 'packages/db', 'db:verify'], databaseEnvironment)
  container = (await command('docker', [...compose, 'ps', '-q', 'postgres'])).trim()
  assert(container)
  await command('docker', [
    'exec',
    container,
    'psql',
    '-U',
    'agent_hq_local_admin',
    '-d',
    'agent_hq',
    '-c',
    "ALTER SYSTEM SET log_statement = 'all'",
    '-c',
    "ALTER SYSTEM SET log_disconnections = 'on'",
    '-c',
    'SELECT pg_reload_conf()',
  ])
  for (const scenario of [
    { label: 'without-signal', active: false, control: true },
    { label: 'idle', active: false },
    { label: 'active', active: true },
  ]) {
    const port = await allocate()
    const baseURL = `https://127.0.0.1:${port}`
    const flags = built.compatibility_flags.filter(
      (flag) => !scenario.control || flag !== 'enable_request_signal'
    )
    const quoted = JSON.stringify
    const bindings = {
      DATABASE_URL: url('agent_hq_local_app'),
      AUTH_TRUSTED_ORIGINS: baseURL,
      CONTROL_PLANE_ORIGIN: 'http://127.0.0.1:9',
      NEON_AUTH_BASE_URL: 'http://127.0.0.1:9',
    }
    const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services=[(name="main",worker=(modules=[(name="wrapper.js",esModule=embed "wrapper.js"),${modules.map((name) => `(name=${quoted(`artifact/${name}`)},esModule=embed ${quoted(`artifact/${name}`)})`).join(',')}],compatibilityDate=${quoted(built.compatibility_date)},compatibilityFlags=${quoted(flags)},bindings=[${Object.entries(
   bindings
 )
   .map(([name, value]) => `(name=${quoted(name)},text=${quoted(value)})`)
   .join(
     ','
   )},(name="HYPERDRIVE",hyperdrive=(designator="postgres",database="agent_hq",user="agent_hq_local_app",password="agent_hq_local_app",scheme="postgresql"))],globalOutbound="loopback")),(name="postgres",external=(address="127.0.0.1:${databasePort}",tcp=())),(name="loopback",network=(allow=["127.0.0.1/32"]))],
 sockets=[(name="https",address="127.0.0.1:${port}",https=(tlsOptions=(keypair=(privateKey=embed "loopback-key.pem",certificateChain=embed "loopback-cert.pem"))),service="main")]
);`
    const configPath = resolve(evidence, `${scenario.label}.capnp`)
    await writeFile(configPath, config)
    const logPath = resolve(evidence, `worker-${scenario.label}.log`)
    const output = createWriteStream(logPath)
    worker = spawn(binary, ['serve', '--experimental', configPath], {
      cwd: evidence,
      env: environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    worker.stdout.pipe(output)
    worker.stderr.pipe(output)
    let startupError
    worker.once('error', (error) => {
      startupError = error
    })
    const deadline = Date.now() + 30_000
    let ready = false
    while (Date.now() < deadline && !ready) {
      if (startupError) throw startupError
      assert.equal(worker.exitCode, null, `Native startup failed; inspect ${logPath}`)
      try {
        ready = await new Promise((ok, fail) => {
          const req = httpsRequest(
            `${baseURL}/api/web-entry`,
            { ca: tls.certificate, agent: false },
            (res) => {
              res.resume()
              res.once('end', () => ok(res.statusCode === 200))
            }
          )
          req.setTimeout(1_000, () => req.destroy(new Error('Readiness timeout')))
          req.once('error', fail)
          req.end()
        })
      } catch {
        /* Startup may not yet have bound its socket. */
      }
      if (!ready) await delay(100)
    }
    assert(ready, `Native Worker not ready; inspect ${logPath}`)
    const client = await disconnectStream({
      baseURL,
      certificate: tls.certificate,
      ...scenario,
      beforeDisconnect: async () => {
        const log = await postgresLogs()
        const matches = [...log.matchAll(/\[(\d+)\] LOG:.*from "app"\."workspace_events" where/g)]
        const streamBackendPid = matches.at(-1)?.[1]
        assert(streamBackendPid, 'The real stream must have read its event log')
        return { offset: log.length, streamBackendPid }
      },
    })
    const { offset, streamBackendPid } = client.databaseCheckpoint
    // The checkpoint precedes socket closure: a fast abort may already have closed
    // the stream's backend by the time this observation allowance ends.
    await delay(500)
    if (scenario.control) {
      await delay(10_000)
      const statements = statementCount((await postgresLogs()).slice(offset))
      assert(statements > 0, 'The no-flag control must detect continued polling')
      assert(!(await readFile(logPath, 'utf8')).includes('DISCONNECT_ABORT '))
      reports.push({ ...scenario, ...client, statementsAfterDisconnect: statements })
    } else {
      // Native disconnect notification is write-driven: idle waits for its next15s heartbeat.
      const abortDeadline = Date.now() + 20_000
      let abortedAt
      while (Date.now() < abortDeadline) {
        const match = (await readFile(logPath, 'utf8')).match(/DISCONNECT_ABORT (\d+)/)
        if (match) {
          abortedAt = Number(match[1])
          break
        }
        await delay(100)
      }
      assert(abortedAt, `Missing native abort; inspect ${logPath}`)
      // Observe the actual closer rather than racing in-flight work with a sleep.
      const closeDeadline = Date.now() + 10_000
      let closedConnections = []
      while (Date.now() < closeDeadline) {
        const afterAbort = (await postgresLogs()).slice(offset)
        closedConnections = [...afterAbort.matchAll(/\[(\d+)\] LOG:\s+disconnection:/g)].filter(
          (match) => match[1] === streamBackendPid
        )
        if (closedConnections.length > 0) break
        await delay(100)
      }
      assert.equal(
        closedConnections.length,
        1,
        'The original stream database connection must close once after abort'
      )
      const windows = []
      for (let index = 0; index < 3; index += 1) {
        const before = (await postgresLogs()).length
        await delay(10_000)
        const statements = statementCount((await postgresLogs()).slice(before))
        windows.push(statements)
        assert.equal(statements, 0, `SQL continued in settled window ${index}`)
      }
      reports.push({
        ...scenario,
        ...client,
        abortedAt,
        abortAfterDisconnectMs: abortedAt - client.disconnectedAt,
        streamBackendPid,
        closedConnections: closedConnections.length,
        settledWindowStatements: windows,
      })
    }
    await writeFile(
      resolve(evidence, 'result.json'),
      JSON.stringify(
        {
          workerdVersion,
          compatibilityFlags: built.compatibility_flags,
          reports,
          productionInvocations: 0,
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ scenario: scenario.label, result: reports.at(-1) }))
    await stopWorker()
  }
  await writeFile(
    resolve(evidence, 'result.json'),
    JSON.stringify(
      {
        workerdVersion,
        compatibilityFlags: built.compatibility_flags,
        reports,
        productionInvocations: 0,
      },
      null,
      2
    )
  )
  console.log(JSON.stringify({ evidence, workerdVersion, reports }))
} catch (error) {
  if (container) {
    try {
      const log = (await postgresLogs())
        .split('\n')
        .filter((line) => !line.includes('DETAIL:  Parameters:'))
        .join('\n')
      await writeFile(resolve(evidence, 'worker-postgres.log'), log)
    } catch {
      /* Preserve the original failure if diagnostics are unavailable. */
    }
  }
  throw error
} finally {
  await stopWorker()
  if (databaseStarted)
    await command('docker', [...compose, 'down', '--volumes'], databaseEnvironment)
}
