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
await cp(artifact, resolve(evidence, 'dist'), { recursive: true })
const modules = []
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      await collect(resolve(directory, entry.name), `${prefix}${entry.name}/`)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))
      modules.push(`${prefix}${entry.name}`)
  }
}
await collect(resolve(evidence, 'dist'))
const main = built.main.split('/').at(-1)
assert(modules.includes(main), 'Built Worker entry must be in the isolated module copy')
// A test-only wrapper observes the original signal without changing response delivery.
await writeFile(
  resolve(evidence, 'wrapper.js'),
  `import application from './dist/${main}';
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
const composeDownTimeoutMs = 30_000
const interruptionController = new AbortController()
const inFlightCommands = new Set()
let interruptionSignal
const assertNotInterrupted = (phase) =>
  assert.equal(
    interruptionSignal,
    undefined,
    `Fixture interrupted by ${interruptionSignal} during ${phase}`
  )
const captureOwnedCommand = (
  program,
  args,
  env = environment,
  { cleanup = false, timeoutMs } = {}
) => {
  if (!cleanup) assertNotInterrupted(`before ${program} command`)
  const pending = captureCommand(program, args, {
    cwd: root,
    env,
    signal: cleanup ? undefined : interruptionController.signal,
    timeoutMs,
  })
  if (!cleanup) {
    inFlightCommands.add(pending)
    pending.then(
      () => inFlightCommands.delete(pending),
      () => inFlightCommands.delete(pending)
    )
  }
  return pending
}
const command = async (program, args, env = environment, options = {}) => {
  const result = await captureOwnedCommand(program, args, env, options)
  if (
    result.status !== 0 ||
    result.error ||
    result.cancelled ||
    result.timedOut ||
    !result.reaped
  ) {
    const details = [
      result.stderr,
      result.stdout,
      result.error?.message,
      result.signal ? `terminated by ${result.signal}` : undefined,
      result.timedOut ? 'command timed out' : undefined,
      !result.reaped ? 'child process was not reaped' : undefined,
    ]
      .filter(Boolean)
      .join('\n')
    throw new Error(
      `${program} failed${result.status === null ? '' : ` (${result.status})`}: ${details}`
    )
  }
  return `${result.stdout}${result.stderr}`
}
const compose = ['compose', '-p', project, '-f', 'compose.yml']
let databaseStarted = false
let worker
let workerSpawnError
const workerStopPromises = new WeakMap()
const workerHasExited = (child) => child.exitCode !== null || child.signalCode !== null
const processGroupExists = (pid) => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}
const signalProcessGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal)
    return undefined
  } catch (error) {
    if (error.code === 'ESRCH') return undefined
    return error
  }
}
const waitForProcessGroupExit = async (pid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true
    await delay(Math.min(50, deadline - Date.now()))
  }
  return !processGroupExists(pid)
}
const stopWorker = () => {
  if (!worker) return Promise.resolve()
  const child = worker
  const prior = workerStopPromises.get(child)
  if (prior) return prior
  const stopping = (async () => {
    if (child.pid === undefined) {
      if (workerHasExited(child)) return
      throw new Error('Native Worker process group is unavailable for cleanup')
    }

    const terminationErrors = []
    const gracefulError = signalProcessGroup(child.pid, 'SIGTERM')
    if (gracefulError) terminationErrors.push(gracefulError)
    if (!(await waitForProcessGroupExit(child.pid, 5_000))) {
      const forceError = signalProcessGroup(child.pid, 'SIGKILL')
      if (forceError) terminationErrors.push(forceError)
      if (!(await waitForProcessGroupExit(child.pid, 2_000)))
        throw new AggregateError(
          [
            ...terminationErrors,
            new Error(`Native Worker process group ${child.pid} survived SIGKILL`),
          ],
          `Could not terminate native Worker process group ${child.pid}`
        )
    }
    if (worker === child) worker = undefined
  })()
  workerStopPromises.set(child, stopping)
  return stopping
}
const assertWorkerAlive = (phase) => {
  assert(worker, `Native Worker is unavailable during ${phase}`)
  assert.equal(workerSpawnError, undefined, `Native Worker failed during ${phase}`)
  assert.equal(worker.exitCode, null, `Native Worker exited during ${phase}`)
  assert.equal(worker.signalCode, null, `Native Worker received a signal during ${phase}`)
}
const waitWithWorkerAlive = async (durationMs, phase) => {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    assertWorkerAlive(phase)
    await delay(Math.min(100, deadline - Date.now()))
    assertWorkerAlive(phase)
  }
}
let container
const postgresLogs = () => command('docker', ['logs', container])
const statementCount = (log) =>
  [...log.matchAll(/(?:statement:|execute [^:\r\n]+:)\s*(\w+)/gi)].length
const reports = []
let cleanupPromise
const cleanupOwnedResources = () => {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    const errors = []
    const commands = await Promise.allSettled(inFlightCommands)
    for (const result of commands) {
      if (result.status === 'rejected') errors.push(result.reason)
      else if (!result.value.reaped)
        errors.push(
          new Error('An interrupted fixture command was not reaped before Compose teardown')
        )
    }
    try {
      await stopWorker()
    } catch (error) {
      errors.push(error)
    }
    if (databaseStarted) {
      try {
        await command('docker', [...compose, 'down', '--volumes'], databaseEnvironment, {
          cleanup: true,
          timeoutMs: composeDownTimeoutMs,
        })
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Could not clean up all disconnect-fixture resources')
  })()
  return cleanupPromise
}
const handleInterruption = (signal) => {
  if (interruptionSignal) return
  interruptionSignal = signal
  interruptionController.abort(new Error(`Disconnect fixture interrupted by ${signal}`))
  void cleanupOwnedResources().then(
    () => process.exit(signal === 'SIGINT' ? 130 : 143),
    (error) => {
      console.error(`Disconnect-fixture cleanup failed after ${signal}:`, error)
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }
  )
}
const onSigint = () => handleInterruption('SIGINT')
const onSigterm = () => handleInterruption('SIGTERM')
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)
let runError
let cleanupError
try {
  databaseStarted = true
  const up = await runWithPullFallback(
    (image) =>
      captureOwnedCommand(
        'docker',
        [...compose, 'up', '-d', '--wait', '--wait-timeout', '60', 'postgres'],
        withComposeImage(databaseEnvironment, image)
      ),
    composePostgresImage(root),
    {
      signal: interruptionController.signal,
      pull: (reference) =>
        captureOwnedCommand('docker', ['pull', '--quiet', reference], databaseEnvironment),
    }
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
    assertNotInterrupted(`before ${scenario.label} scenario`)
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
 services=[(name="main",worker=(modules=[(name="wrapper.js",esModule=embed "wrapper.js"),${modules.map((name) => `(name=${quoted(`dist/${name}`)},esModule=embed ${quoted(`dist/${name}`)})`).join(',')}],compatibilityDate=${quoted(built.compatibility_date)},compatibilityFlags=${quoted(flags)},bindings=[${Object.entries(
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
    assertNotInterrupted(`${scenario.label} Worker startup`)
    worker = spawn(binary, ['serve', '--experimental', configPath], {
      cwd: evidence,
      env: environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    worker.stdout.pipe(output)
    worker.stderr.pipe(output)
    worker.once('error', (error) => {
      workerSpawnError = error
    })
    const deadline = Date.now() + 30_000
    let ready = false
    while (Date.now() < deadline && !ready) {
      if (workerSpawnError) throw workerSpawnError
      assertWorkerAlive('startup')
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
    await waitWithWorkerAlive(500, 'post-disconnect observation')
    if (scenario.control) {
      await waitWithWorkerAlive(10_000, 'no-flag control observation')
      assertWorkerAlive('no-flag control SQL inspection')
      const statements = statementCount((await postgresLogs()).slice(offset))
      assertWorkerAlive('no-flag control SQL inspection')
      assert(statements > 0, 'The no-flag control must detect continued polling')
      assert(!(await readFile(logPath, 'utf8')).includes('DISCONNECT_ABORT '))
      reports.push({
        ...scenario,
        ...client.receipt,
        statementsAfterDisconnect: statements,
      })
    } else {
      // Native disconnect notification is write-driven: idle waits for its next15s heartbeat.
      const abortDeadline = Date.now() + 20_000
      let abortedAt
      while (Date.now() < abortDeadline) {
        assertWorkerAlive(`${scenario.label} abort observation`)
        const match = (await readFile(logPath, 'utf8')).match(/DISCONNECT_ABORT (\d+)/)
        if (match) {
          abortedAt = Number(match[1])
          break
        }
        await delay(100)
        assertWorkerAlive(`${scenario.label} abort observation`)
      }
      assert(abortedAt, `Missing native abort; inspect ${logPath}`)
      // Observe the actual closer rather than racing in-flight work with a sleep.
      const closeDeadline = Date.now() + 10_000
      let closedConnections = []
      while (Date.now() < closeDeadline) {
        assertWorkerAlive(`${scenario.label} database-close observation`)
        const afterAbort = (await postgresLogs()).slice(offset)
        assertWorkerAlive(`${scenario.label} database-close observation`)
        closedConnections = [...afterAbort.matchAll(/\[(\d+)\] LOG:\s+disconnection:/g)].filter(
          (match) => match[1] === streamBackendPid
        )
        if (closedConnections.length > 0) break
        await delay(100)
        assertWorkerAlive(`${scenario.label} database-close observation`)
      }
      assert.equal(
        closedConnections.length,
        1,
        'The original stream database connection must close once after abort'
      )
      const windows = []
      for (let index = 0; index < 3; index += 1) {
        assertWorkerAlive(`${scenario.label} settled window ${index} start`)
        const before = (await postgresLogs()).length
        assertWorkerAlive(`${scenario.label} settled window ${index} start`)
        await waitWithWorkerAlive(10_000, `${scenario.label} settled window ${index}`)
        const statements = statementCount((await postgresLogs()).slice(before))
        assertWorkerAlive(`${scenario.label} settled window ${index} end`)
        windows.push(statements)
        assert.equal(statements, 0, `SQL continued in settled window ${index}`)
      }
      assertWorkerAlive(`${scenario.label} fresh API request start`)
      const healthyRequest = await client.checkHealthyRequest()
      assertWorkerAlive(`${scenario.label} fresh API request end`)
      reports.push({
        ...scenario,
        ...client.receipt,
        abortedAt,
        abortAfterDisconnectMs: abortedAt - client.disconnectedAt,
        streamBackendPid,
        closedConnections: closedConnections.length,
        settledWindowStatements: windows,
        healthyRequest,
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
  runError = error
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
} finally {
  try {
    await cleanupOwnedResources()
  } catch (error) {
    cleanupError = error
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}
if (runError && cleanupError)
  throw new AggregateError(
    [runError, cleanupError],
    'Disconnect fixture failed and cleanup was incomplete'
  )
if (runError) throw runError
if (cleanupError) throw cleanupError
