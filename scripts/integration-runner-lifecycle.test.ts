import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const nodePath = Bun.which('node')
if (!nodePath) throw new Error('Node.js is required for the isolated runner VM')
const runnerPath = fileURLToPath(new URL('./test-integration.mjs', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

// Run the production runner in a child VM: all process, Docker, provisioning,
// target and inventory boundaries are synthetic and cannot reach real resources.
function exercise(options: {
  port?: string
  runningBefore?: boolean
  failStart?: boolean
  explicit?: boolean
  failAt?: string
  stopFails?: boolean
  captureStopFails?: boolean
  capturePartial?: boolean
  success?: boolean
  signal?: string
  childSignal?: string
}) {
  const child = `
    import vm from 'node:vm'
    import { readFileSync } from 'node:fs'
    import { resolve } from 'node:path'
    const options = ${JSON.stringify(options)}
    const calls = []
    const databaseEnvironments = []
    let created = false
    const listeners = new Map()
    const errors = []
    const fakeProcess = {
      on(name, listener) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set) },
      off(name, listener) { listeners.get(name)?.delete(listener) },
      kill(pid, signal) { calls.push(['signal', signal]) },
      pid: 123,
    }
    const context = vm.createContext({
      AbortController,
      console: { log() {}, warn() {}, error(message) { errors.push(message) } },
      process: {
        ...fakeProcess,
        env: {
          ...(options.explicit ? { DATABASE_URL: 'synthetic', DATABASE_URL_UNPOOLED: 'synthetic', DATABASE_MIGRATION_URL: 'synthetic' } : {}),
          ...(options.port !== undefined ? { ADEA_POSTGRES_PORT: options.port } : {}),
        },
        argv: ['node', 'test-integration.mjs'],
        stdout: { write() {} }, stderr: { write() {} },
      },
    })
    const stub = exports => new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
    const dependencies = {
      'node:path': stub({ resolve }),
      'node:timers/promises': stub({ setTimeout: async () => {} }),
      'node:child_process': stub({ spawnSync(command, args, configuration) {
        if (configuration?.env?.DATABASE_URL) databaseEnvironments.push(Object.fromEntries(
          ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_MIGRATION_URL'].map(name => [name, configuration.env[name]])
        ))
        calls.push([command, ...args])
        if (command === 'docker' && args[1] === 'ps')
          return { status: 0, stdout: options.runningBefore ? 'postgres\\n' : '' }
        if (command === 'docker' && args[1] === 'stop' && options.stopFails)
          return { status: 9 }
        if (args.includes(options.failAt)) return { status: options.childSignal ? null : 7, signal: options.childSignal }
        return { status: 0, stdout: '' }
      } }),
      './test-target-guard.mjs': stub({ assertLocalTestTargets() {} }),
      './self-hosted-auth-lifecycle.ts': stub({
        // The qualification is exercised by its own test; here the runner only
        // has to call it, so the stub records the URL it was handed.
        proveSelfHostedAuthLifecycle(command, input) {
          calls.push(['auth-lifecycle', input.databaseUrl])
        },
      }),
      './integration-inventory.mjs': stub({
        parseIntegrationShard() {}, discoverIntegrationInventory() { return {} },
        planIntegrationRun() { return { packageFiles: [], routeFiles: [] } },
      }),
      './capture-provisioning.mjs': stub({
        captureProvisioningDatabaseUrlVariable: 'SYNTHETIC_UNUSED',
        startCaptureProvisioning(register) {
          if (!options.success && !options.failAt && !options.capturePartial)
            throw new Error('synthetic downstream failure')
          const handle = { databaseUrl: 'synthetic', stop() {
            calls.push(['capture-stop'])
            if (options.captureStopFails) throw new Error('synthetic capture removal failure')
          } }
          register(handle)
          if (options.capturePartial) throw new Error('synthetic partial capture failure')
          return handle
        },
      }),
      './docker-pull-backoff.mjs': stub({
        composePostgresImage() { return 'synthetic-unused' }, withComposeImage() { return {} },
        runWithPullFallback(attempt) { return attempt('synthetic-unused') },
        async captureCommand(command, args) {
          calls.push([command, ...args])
          created = true
          if (options.signal) {
            for (const listener of [...(listeners.get(options.signal) ?? [])]) listener()
            // Model termination: the interrupted startup never resumes.
            throw new Error('synthetic interrupted startup')
          }
          return { status: options.failStart ? 1 : 0, stdout: '', stderr: 'synthetic health failure' }
        },
      }),
    }
    const runner = new vm.SourceTextModule(readFileSync(process.argv[1], 'utf8'), {
      context, initializeImportMeta(meta) { meta.dirname = '/synthetic/adea/scripts' },
    })
    await runner.link(specifier => {
      if (!Object.hasOwn(dependencies, specifier)) throw Error('Unexpected dependency: ' + specifier)
      return dependencies[specifier]
    })
    let failure
    try { await runner.evaluate() } catch (error) { failure = error.message }
    for (const listener of [...(listeners.get('exit') ?? [])]) listener(failure ? 1 : 0)
    console.log(JSON.stringify({ created, failure, calls, errors, databaseEnvironments }))
  `
  const result = spawnSync(
    nodePath,
    ['--experimental-vm-modules', '--input-type=module', '--eval', child, runnerPath],
    {
      encoding: 'utf8',
      env: {},
      timeout: 10_000,
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as {
    databaseEnvironments: Record<string, string>[]
    created: boolean
    failure: string
    calls: string[][]
    errors: string[]
  }
}

const stops = (calls: string[][]) =>
  calls.filter((call) => call.join(' ') === 'docker compose stop postgres')

test('stops its PostgreSQL startup attempt once when health wait fails after creation', () => {
  const result = exercise({ failStart: true })
  expect(result.created).toBe(true)
  expect(stops(result.calls)).toHaveLength(1)
  expect(result.failure).toContain(
    'docker compose up -d --wait --wait-timeout 30 postgres failed with exit code 1'
  )
})

test('stops its PostgreSQL once after successful startup and downstream failure', () => {
  const result = exercise({ failStart: false })
  expect(result.created).toBe(true)
  expect(stops(result.calls)).toHaveLength(1)
  expect(result.failure).toBe('synthetic downstream failure')
})

test('never starts or stops a pre-existing running PostgreSQL service', () => {
  const result = exercise({ runningBefore: true })
  expect(result.created).toBe(false)
  expect(stops(result.calls)).toHaveLength(0)
  expect(result.failure).toBe('synthetic downstream failure')
})

test('explicit database target never invokes Docker', () => {
  const result = exercise({ explicit: true })
  expect(result.calls.filter((call) => call[0] === 'docker')).toHaveLength(0)
  expect(result.failure).toBe('synthetic downstream failure')
})

for (const failAt of ['scripts/database-health.mjs', 'db:verify', 'test']) {
  test(`cleans up after ${failAt} failure and preserves the primary error`, () => {
    const result = exercise({ failAt, stopFails: true, captureStopFails: true })
    expect(stops(result.calls)).toHaveLength(1)
    expect(result.failure).toContain('failed with exit code 7')
    expect(result.errors.some((message) => message.includes('stop postgres failed'))).toBe(true)
    expect(result.calls.filter((call) => call[0] === 'capture-stop')).toHaveLength(
      failAt === 'test' ? 1 : 0
    )
  })
}

test('releases a registered capture handle after partial capture startup', () => {
  const result = exercise({ capturePartial: true, captureStopFails: true })
  expect(result.failure).toBe('synthetic partial capture failure')
  expect(stops(result.calls)).toHaveLength(1)
  expect(result.calls.filter((call) => call[0] === 'capture-stop')).toHaveLength(1)
})

test('successful tests release both resources exactly once', () => {
  const result = exercise({ success: true })
  expect(result.failure).toBeUndefined()
  expect(stops(result.calls)).toHaveLength(1)
  expect(result.calls.filter((call) => call[0] === 'capture-stop')).toHaveLength(1)
})

for (const options of [{ stopFails: true }, { captureStopFails: true }]) {
  test(`teardown failure fails an otherwise successful run: ${JSON.stringify(options)}`, () => {
    const result = exercise({ success: true, ...options })
    expect(result.failure).toContain(
      options.stopFails ? 'stop postgres' : 'capture removal failure'
    )
    expect(stops(result.calls)).toHaveLength(1)
    expect(result.calls.filter((call) => call[0] === 'capture-stop')).toHaveLength(1)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} during asynchronous startup stops the owned service once and re-raises`, () => {
    const result = exercise({ signal })
    expect(stops(result.calls)).toHaveLength(1)
    expect(result.calls.filter((call) => call[0] === 'signal')).toEqual([['signal', signal]])
  })
}

test('signalled test child retains its signal in the primary error', () => {
  const result = exercise({ failAt: 'test', childSignal: 'SIGTERM', stopFails: true })
  expect(result.failure).toContain('failed with signal SIGTERM')
  expect(stops(result.calls)).toHaveLength(1)
})

// Execute the unmodified runner through this test's pinned Bun executable, with
// disposable module fixtures and PATH commands. No Docker or database is reachable.
async function exerciseBun(signal?: 'SIGINT' | 'SIGTERM', failMigration = false) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-runner-lifecycle-'))
  const scripts = join(directory, 'scripts')
  const bin = join(directory, 'bin')
  mkdirSync(scripts)
  mkdirSync(bin)
  const calls = join(directory, 'calls')
  const ready = join(directory, 'ready')
  const fixtureLog = `import { appendFileSync, writeFileSync } from 'node:fs';
    const log = value => appendFileSync(process.env.FIXTURE_CALLS, value + '\\n');`
  writeFileSync(join(scripts, 'test-integration.mjs'), readFileSync(runnerPath))
  writeFileSync(
    join(scripts, 'test-target-guard.mjs'),
    'export function assertLocalTestTargets() {}'
  )
  writeFileSync(
    join(scripts, 'self-hosted-auth-lifecycle.ts'),
    `${fixtureLog}
    export function proveSelfHostedAuthLifecycle(command, input) {
      log('auth-lifecycle ' + new URL(input.databaseUrl).hostname);
    }
  `
  )
  writeFileSync(
    join(scripts, 'integration-inventory.mjs'),
    `
    export function parseIntegrationShard() {}
    export function discoverIntegrationInventory() {}
    export function planIntegrationRun() { return { packageFiles: [], routeFiles: [] } }
  `
  )
  writeFileSync(
    join(scripts, 'capture-provisioning.mjs'),
    `${fixtureLog}
    export const captureProvisioningDatabaseUrlVariable = 'SYNTHETIC_UNUSED';
    export function startCaptureProvisioning(register) {
      const handle = { databaseUrl: 'synthetic', stop() { log('capture-stop') } };
      register(handle); return handle;
    }
  `
  )
  writeFileSync(
    join(scripts, 'docker-pull-backoff.mjs'),
    `${fixtureLog}
    export function composePostgresImage() { return 'synthetic' }
    export function withComposeImage(env) { return env }
    export function runWithPullFallback(attempt) { return attempt('synthetic') }
    export async function captureCommand(command, args, options) {
      log('compose-start');
      if (process.env.FIXTURE_INTERRUPT) {
        writeFileSync(process.env.FIXTURE_READY, 'ready');
        await new Promise((resolve, reject) => {
          const timer = setInterval(() => {}, 1000);
          options.signal.addEventListener('abort', () => {
            clearInterval(timer); log('startup-reaped'); reject(options.signal.reason);
          }, { once: true });
        });
      }
      return { status: 0 };
    }
  `
  )
  for (const command of ['bun', 'node', 'docker']) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh
      echo "${command} $*" >> "$FIXTURE_CALLS"
      if [ "$FIXTURE_FAIL_MIGRATION" = 1 ] && [ "$4" = db:verify ]; then exit 7; fi
      exit 0
    `,
      { mode: 0o755 }
    )
  }
  let child: ReturnType<typeof spawn> | undefined
  try {
    child = spawn(process.execPath, [join(scripts, 'test-integration.mjs')], {
      env: {
        PATH: bin,
        FIXTURE_CALLS: calls,
        FIXTURE_READY: ready,
        FIXTURE_INTERRUPT: signal ? '1' : '',
        FIXTURE_FAIL_MIGRATION: failMigration ? '1' : '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (data) => {
      stderr += data
    })
    const completion = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child!.once('error', reject)
        child!.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }))
      }
    )
    if (signal) {
      const deadline = Date.now() + 3000
      while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null)
        await Bun.sleep(10)
      expect(existsSync(ready), stderr).toBe(true)
      child.kill(signal)
    }
    const result = await Promise.race([
      completion,
      Bun.sleep(4000).then(() => {
        throw new Error('synthetic Bun runner deadline exceeded')
      }),
    ])
    return { ...result, stderr, calls: readFileSync(calls, 'utf8').trim().split('\n') }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child!.once('exit', resolve))
      child.kill('SIGKILL')
      await exited
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`actual Bun runner cleans partial startup and terminates on ${signal}`, async () => {
    const result = await exerciseBun(signal)
    expect(result.signal).toBe(signal)
    expect(result.calls.indexOf('startup-reaped')).toBeLessThan(
      result.calls.indexOf('docker compose stop postgres')
    )
    expect(result.calls).toContain('startup-reaped')
    expect(result.calls.filter((call) => call === 'docker compose stop postgres')).toHaveLength(1)
  })
}

test('actual Bun runner cleans a failed migration and retains its exit error', async () => {
  const result = await exerciseBun(undefined, true)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('db:verify failed with exit code 7')
  expect(result.calls.filter((call) => call === 'docker compose stop postgres')).toHaveLength(1)
  expect(result.calls).not.toContain('capture-stop')
})

test('actual Bun runner cleans both fixtures after a successful run', async () => {
  const result = await exerciseBun()
  expect(result.code, result.stderr).toBe(0)
  expect(result.calls.filter((call) => call === 'docker compose stop postgres')).toHaveLength(1)
  expect(result.calls.filter((call) => call === 'capture-stop')).toHaveLength(1)
  // The self-hosted auth lifecycle is proven on the way through, against the
  // loopback instance this lane owns.
  expect(result.calls.filter((call) => call.startsWith('auth-lifecycle '))).toEqual([
    'auth-lifecycle 127.0.0.1',
  ])
})

// Keep the production lifecycle modules byte-for-byte intact. Only the external
// commands and unrelated inventory/target boundaries are disposable fixtures.
async function exerciseRealLifecycle(
  mode: 'startup' | 'backoff' | 'capture-signal' | 'primary-error',
  forceRecovery = false,
  observeRecovery: (evidence: { requests: number; acknowledged: boolean }) => void = () => {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-real-lifecycle-'))
  const scripts = join(directory, 'scripts')
  const bin = join(directory, 'bin')
  mkdirSync(scripts)
  mkdirSync(bin)
  const eventsPath = join(directory, 'events')
  const ready = join(directory, 'ready')
  const descendants = join(directory, 'descendants')
  const fixtureToken = randomUUID()
  let confirmedExited = false
  const cleanupEvidence = { requests: 0 }
  for (const file of [
    'test-integration.mjs',
    'docker-pull-backoff.mjs',
    'capture-provisioning.mjs',
  ]) {
    writeFileSync(join(scripts, file), readFileSync(new URL(file, import.meta.url)))
  }
  writeFileSync(
    join(directory, 'compose.yml'),
    readFileSync(new URL('../compose.yml', import.meta.url))
  )
  writeFileSync(
    join(scripts, 'test-target-guard.mjs'),
    'export function assertLocalTestTargets() {}'
  )
  writeFileSync(
    join(scripts, 'self-hosted-auth-lifecycle.ts'),
    'export function proveSelfHostedAuthLifecycle() {}'
  )
  writeFileSync(
    join(scripts, 'integration-inventory.mjs'),
    `
    export function parseIntegrationShard() {}
    export function discoverIntegrationInventory() {}
    export function planIntegrationRun() { return { packageFiles: [], routeFiles: [] } }
  `
  )
  const executable = `#!${nodePath}
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const path = require('node:path');
    const command = path.basename(process.argv[1]);
    const args = process.argv.slice(2);
    const mode = process.env.FIXTURE_MODE;
    const dir = process.env.FIXTURE_DIRECTORY;
    const log = (event, detail) => fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({ event, detail }) + '\\n');
    const resource = name => path.join(dir, name);
    const markReady = () => fs.writeFileSync(resource('ready'), 'ready');
    if (command === 'docker') {
      if (args[0] === 'compose' && args[1] === 'ps') process.exit(0);
      if (args[0] === 'compose' && args[1] === 'up') {
        log('compose-up'); fs.writeFileSync(resource('compose-resource'), 'owned');
        if (mode === 'backoff') { console.error('toomanyrequests: synthetic registry limit'); process.exit(1); }
        if (mode === 'startup') {
          fs.writeFileSync(resource('compose-pid'), String(process.pid));
          const code = \`const fs = require('node:fs');
            fs.writeFileSync(process.env.FIXTURE_DIRECTORY + '/descendant-ready', 'ready');
            process.on('SIGTERM', () => { fs.appendFileSync(process.env.FIXTURE_DIRECTORY + '/events', JSON.stringify({event:'descendant-term'}) + '\\\\n'); setTimeout(() => process.exit(0), 100) });
            setInterval(() => {}, 1000);\`;
          const descendant = spawn(process.execPath, ['-e', code], { env: process.env, stdio: 'ignore' });
          fs.writeFileSync(resource('descendants'), String(descendant.pid));
          process.on('SIGTERM', () => log('compose-term'));
          descendant.on('exit', () => {
            log('descendant-reaped');
            fs.writeFileSync(resource('supervisor-exited'), process.env.FIXTURE_TOKEN);
            process.exit(0);
          });
          fs.writeFileSync(resource('supervisor-ready'), process.env.FIXTURE_TOKEN);
          // Only this live owner may signal its retained ChildProcess handle.
          // A per-run capability request never targets a recycled numeric PID.
          setInterval(() => {
            if (!fs.existsSync(resource('shutdown-request'))) return;
            if (fs.readFileSync(resource('shutdown-request'), 'utf8') !== process.env.FIXTURE_TOKEN) return;
            fs.rmSync(resource('shutdown-request'));
            log('supervisor-shutdown');
            if (descendant.exitCode === null && descendant.signalCode === null) descendant.kill('SIGKILL');
          }, 10);
          const readyTimer = setInterval(() => {
            if (fs.existsSync(resource('descendant-ready'))) { clearInterval(readyTimer); markReady() }
          }, 5);
          return;
        }
        process.exit(0);
      }
      if (args[0] === 'pull') { log('pull'); console.error('synthetic fallback unavailable'); process.exit(1); }
      if (args[0] === 'compose' && args[1] === 'stop') {
        let groupAlive = false;
        if (fs.existsSync(resource('compose-pid'))) {
          try { process.kill(-Number(fs.readFileSync(resource('compose-pid'), 'utf8')), 0); groupAlive = true }
          catch (error) { if (error.code !== 'ESRCH') throw error }
        }
        log('compose-stop', { groupAlive });
        fs.rmSync(resource('compose-resource'), { force: true });
        if (mode === 'primary-error') { console.error('synthetic compose cleanup failure'); process.exit(9) }
        process.exit(0);
      }
      if (args[0] === 'info') process.exit(0);
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1];
        log('capture-run', name); fs.writeFileSync(resource('capture-resource'), name);
        // The pinned image declares its data directory as a volume, so the instance carries one
        // anonymous volume, the way Docker creates it.
        fs.writeFileSync(resource('capture-volume'), 'synthetic-anonymous-volume');
        console.log('synthetic-container-id'); process.exit(0);
      }
      if (args[0] === 'inspect') {
        const name = args[args.length - 1];
        if (!fs.existsSync(resource('capture-resource')) || fs.readFileSync(resource('capture-resource'), 'utf8') !== name) {
          console.error('Error response from daemon: No such object: ' + name); process.exit(1);
        }
        console.log(JSON.stringify([{ Type: 'volume', Name: 'synthetic-anonymous-volume', Destination: '/var/lib/postgresql' }]));
        process.exit(0);
      }
      if (args[0] === 'volume') {
        if (args[1] === 'inspect') {
          if (!fs.existsSync(resource('capture-volume'))) {
            console.error('Error: no such volume: synthetic-anonymous-volume'); process.exit(1);
          }
          console.log(JSON.stringify({ 'com.docker.volume.anonymous': '' })); process.exit(0);
        }
        if (args[1] === 'rm') {
          log('capture-volume-rm', args[2]); fs.rmSync(resource('capture-volume'), { force: true }); process.exit(0);
        }
      }
      if (args[0] === 'port') { console.log('127.0.0.1:54321'); process.exit(0) }
      if (args[0] === 'exec') process.exit(0);
      if (args[0] === 'rm') {
        log('capture-rm', args[2]); fs.rmSync(resource('capture-resource'), { force: true });
        if (mode === 'primary-error') { console.error('synthetic capture cleanup failure'); process.exit(8) }
        process.exit(0);
      }
      throw new Error('Unexpected fake Docker command: ' + args[0]);
    }
    if (command === 'bun' && args.includes('test')) {
      log('test');
      if (mode === 'primary-error') process.exit(7);
      if (mode === 'capture-signal') {
        markReady(); setTimeout(() => process.exit(0), 200); return;
      }
    }
  `.replaceAll('\\`', '`')
  for (const command of ['docker', 'bun', 'node']) {
    writeFileSync(join(bin, command), executable, { mode: 0o755 })
  }
  let child: ReturnType<typeof spawn> | undefined
  try {
    child = spawn(process.execPath, [join(scripts, 'test-integration.mjs')], {
      env: {
        PATH: bin,
        FIXTURE_DIRECTORY: directory,
        FIXTURE_MODE: mode,
        FIXTURE_TOKEN: fixtureToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (data) => {
      stderr += data
    })
    const completion = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child!.once('error', reject)
        child!.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }))
      }
    )
    const deadline = Date.now() + 6000
    if (mode !== 'primary-error') {
      while (!(mode === 'backoff' ? stderr.includes('retry 1 of') : existsSync(ready))) {
        if (Date.now() >= deadline || child.exitCode !== null || child.signalCode !== null)
          throw new Error('real-helper fixture did not become ready: ' + stderr)
        await Bun.sleep(10)
      }
      if (forceRecovery) throw new Error('synthetic fixture supervision failure')
      child.kill('SIGTERM')
      // Deliver a second signal while startup reaping or synchronous tests are
      // pending. Cleanup must remain idempotent across both lifecycle listeners.
      await Bun.sleep(25)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    const result = await Promise.race([
      completion,
      Bun.sleep(6000).then(() => {
        throw new Error('real-helper fixture completion deadline exceeded: ' + stderr)
      }),
    ])
    const events = readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as {
      event: string
      detail?: { groupAlive: boolean } | string
    }[]
    if (existsSync(descendants)) {
      const pid = Number(readFileSync(descendants, 'utf8'))
      let exitCode
      try {
        process.kill(pid, 0)
      } catch (error) {
        exitCode = (error as NodeJS.ErrnoException).code
      }
      expect(exitCode).toBe('ESRCH')
    }
    confirmedExited = true
    return {
      ...result,
      stderr,
      events,
      cleanupEvidence,
      resources: ['compose-resource', 'capture-resource', 'capture-volume'].filter((name) =>
        existsSync(join(directory, name))
      ),
    }
  } catch (error) {
    const progress = existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf8')
      : '(no fixture events)'
    throw new Error(`${(error as Error).message}; fixture progress: ${progress}`, { cause: error })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child!.once('exit', resolve))
      child.kill('SIGKILL')
      await exited
    }
    await requestSupervisedFixtureShutdown(
      confirmedExited,
      () => {
        const identity = join(directory, 'supervisor-ready')
        if (!existsSync(identity)) return false
        if (readFileSync(identity, 'utf8') !== fixtureToken)
          throw new Error('Refusing cleanup of a fixture with mismatched identity')
        const exited = join(directory, 'supervisor-exited')
        if (existsSync(exited) && readFileSync(exited, 'utf8') === fixtureToken) return false
        cleanupEvidence.requests += 1
        writeFileSync(join(directory, 'shutdown-request'), fixtureToken)
        return true
      },
      async () => {
        const deadline = Date.now() + 3000
        const exited = join(directory, 'supervisor-exited')
        while (!existsSync(exited) && Date.now() < deadline) await Bun.sleep(10)
        expect(existsSync(exited), 'owned fixture supervisor did not acknowledge exit').toBe(true)
        expect(readFileSync(exited, 'utf8')).toBe(fixtureToken)
        observeRecovery({ requests: cleanupEvidence.requests, acknowledged: true })
      }
    )
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const mode of ['startup', 'backoff', 'capture-signal'] as const) {
  test(`real lifecycle helpers: duplicate signals during ${mode} clean only owned fixtures`, async () => {
    const result = await exerciseRealLifecycle(mode)
    expect(result.signal, result.stderr).toBe('SIGTERM')
    expect(result.resources).toEqual([])
    const composeStops = result.events.filter(({ event }) => event === 'compose-stop')
    expect(composeStops).toEqual([{ event: 'compose-stop', detail: { groupAlive: false } }])
    expect(result.events.filter(({ event }) => event === 'compose-up')).toHaveLength(1)
    if (mode === 'startup') {
      const names = result.events.map(({ event }) => event)
      expect(names).toContain('descendant-term')
      expect(names.indexOf('descendant-reaped')).toBeLessThan(names.indexOf('compose-stop'))
      expect(names).not.toContain('pull')
    }
    if (mode === 'backoff') {
      expect(result.stderr).toContain('retry 1 of')
      expect(result.events.filter(({ event }) => event === 'pull')).toHaveLength(2)
    }
    const captures = result.events.filter(({ event }) => event === 'capture-run')
    const removals = result.events.filter(({ event }) => event === 'capture-rm')
    if (mode === 'capture-signal') {
      expect(captures).toHaveLength(1)
      expect(removals.map(({ detail }) => detail)).toEqual(captures.map(({ detail }) => detail))
    } else {
      expect(captures).toHaveLength(0)
      expect(removals).toHaveLength(0)
    }
  }, 15000)
}

test('real lifecycle helpers preserve test failure when both resource teardowns fail', async () => {
  const result = await exerciseRealLifecycle('primary-error')
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('test --timeout 30000 failed with exit code 7')
  expect(result.stderr).toContain('synthetic compose cleanup failure')
  expect(result.stderr).toContain('synthetic capture cleanup failure')
  expect(result.events.filter(({ event }) => event === 'compose-stop')).toHaveLength(1)
  const captures = result.events.filter(({ event }) => event === 'capture-run')
  expect(captures).toHaveLength(1)
  // The capture removal that was not verified is tried again, so the same
  // container is named twice, and both attempts are the container that started.
  const captureRemovals = result.events.filter(({ event }) => event === 'capture-rm')
  expect(captureRemovals).toHaveLength(2)
  expect(captureRemovals.map(({ detail }) => detail)).toEqual([
    ...captures.map(({ detail }) => detail),
    ...captures.map(({ detail }) => detail),
  ])
  expect(result.resources).toEqual([])
}, 15000)

// Confirmed completion must never replay PID files or issue a shutdown request.
async function requestSupervisedFixtureShutdown(
  confirmedExited: boolean,
  request: () => boolean,
  awaitExit: () => Promise<void>
) {
  if (confirmedExited) return
  if (request()) await awaitExit()
}

test('confirmed fixture exit never signals a stale PID or requests shutdown', async () => {
  let requests = 0
  await requestSupervisedFixtureShutdown(
    true,
    () => {
      requests += 1
      throw new Error('must not target a PID that could have been recycled')
    },
    async () => {
      throw new Error('already reaped')
    }
  )
  expect(requests).toBe(0)
  const result = await exerciseRealLifecycle('startup')
  expect(result.cleanupEvidence.requests).toBe(0)
  expect(result.events.map(({ event }) => event)).not.toContain('supervisor-shutdown')
}, 15000)

test('failed fixture supervision cleans a live descendant through its identity-checked owner', async () => {
  const recovery: { requests: number; acknowledged: boolean }[] = []
  await expect(
    exerciseRealLifecycle('startup', true, (evidence) => recovery.push(evidence))
  ).rejects.toThrow('synthetic fixture supervision failure')
  expect(recovery).toEqual([{ requests: 1, acknowledged: true }])
}, 15000)

for (const port of [undefined, '1', '49981', '65535']) {
  test(`managed runner uses configured loopback port ${port ?? '55432'} for every database URL`, () => {
    const result = exercise({ port, success: true })
    expect(result.failure).toBeUndefined()
    expect(result.databaseEnvironments.length).toBeGreaterThan(0)
    for (const environment of result.databaseEnvironments) {
      expect(
        Object.values(environment).every((url) =>
          url.includes(`@127.0.0.1:${port ?? '55432'}/agent_hq?`)
        )
      ).toBe(true)
    }
    expect(stops(result.calls)).toHaveLength(1)
  })
}

for (const port of [
  '',
  '0',
  '65536',
  '999999',
  '-1',
  '+5432',
  '05432',
  '1.5',
  '1e3',
  '0xD87A',
  ' 5432',
  '5432 ',
  '5432\n',
  '5432/other',
  '5432?host=remote',
]) {
  test(`managed runner rejects malformed port ${JSON.stringify(port)} before any command`, () => {
    const result = exercise({ port, success: true })
    expect(result.failure).toBe('ADEA_POSTGRES_PORT must be a decimal TCP port between 1 and 65535')
    expect(result.calls).toEqual([])
  })
}

test('configured local port preserves pre-existing service ownership', () => {
  const result = exercise({ port: '49982', runningBefore: true, success: true })
  expect(result.failure).toBeUndefined()
  expect(result.created).toBe(false)
  expect(stops(result.calls)).toHaveLength(0)
  expect(result.databaseEnvironments.every((env) => env.DATABASE_URL.includes(':49982/'))).toBe(
    true
  )
})

test('configured local port preserves partial-start cleanup and its primary error', () => {
  const result = exercise({ port: '49983', failStart: true, stopFails: true })
  expect(result.failure).toContain(
    'up -d --wait --wait-timeout 30 postgres failed with exit code 1'
  )
  expect(stops(result.calls)).toHaveLength(1)
})

test('explicit target is independent of an unused malformed Compose port', () => {
  const result = exercise({ port: 'unused', explicit: true, success: true })
  expect(result.failure).toBeUndefined()
  expect(result.calls.filter((call) => call[0] === 'docker')).toHaveLength(0)
  expect(result.databaseEnvironments.every((env) => env.DATABASE_URL === 'synthetic')).toBe(true)
})

// Resolves a module under the conditions the lane runs its package suites with.
function resolvesUnderLaneConditions(module: string, cwd: string): boolean {
  const result = spawnSync(
    'bun',
    [
      '--conditions=react-server',
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(module)})`,
    ],
    { cwd, encoding: 'utf8', timeout: 120_000 }
  )
  return result.status === 0
}

test('the integration lane builds the compiled spatial package before the suites run', () => {
  const result = exercise({ success: true })
  const calls = result.calls.map((call) => call.join(' '))
  const build = calls.indexOf('bun run --cwd packages/spatial build')
  const provisioning = calls.findIndex((call) => call.startsWith('docker compose up'))
  const suites = calls.findIndex((call) => call.startsWith('bun --conditions=react-server test'))
  expect(build).toBeGreaterThan(-1)
  // The build precedes the provisioning and the suites, so a clean checkout has the compiled
  // entry before any suite can import it. The provisioning and its cleanup are unchanged.
  expect(provisioning).toBeGreaterThan(build)
  expect(suites).toBeGreaterThan(build)
  expect(stops(result.calls)).toHaveLength(1)
})

// The joined Sim acceptance runs in the package suites and imports the hosted service's server
// modules, and those import the compiled Sim bridge through the spatial package's export map. A
// clean checkout has no compiled output, so the lane has to build the spatial package before the
// suites run. This proves the resolution from a clean checkout: the real package with no compiled
// output, built by the lane's own invocation, and then imported through the server module that
// needs it.
test('the joined Sim acceptance resolves the compiled spatial bridge from a clean checkout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'adea-spatial-resolution-'))
  try {
    // The clean checkout: the real package, the real export map, and no compiled output.
    cpSync(join(repositoryRoot, 'packages/spatial'), join(directory, 'packages/spatial'), {
      recursive: true,
    })
    rmSync(join(directory, 'packages/spatial/dist'), { recursive: true, force: true })
    copyFileSync(join(repositoryRoot, 'tsconfig.base.json'), join(directory, 'tsconfig.base.json'))
    mkdirSync(join(directory, 'packages/config'), { recursive: true })
    copyFileSync(
      join(repositoryRoot, 'packages/config/tsconfig.base.json'),
      join(directory, 'packages/config/tsconfig.base.json')
    )
    // The workspace links the package the way a workspace install does, and the toolchain the
    // package's own build needs is the repository's.
    mkdirSync(join(directory, 'node_modules/@adea-ai'), { recursive: true })
    symlinkSync(
      join(directory, 'packages/spatial'),
      join(directory, 'node_modules/@adea-ai/spatial')
    )
    symlinkSync(
      join(repositoryRoot, 'node_modules/bun-types'),
      join(directory, 'node_modules/bun-types')
    )
    symlinkSync(
      join(repositoryRoot, 'node_modules/typescript'),
      join(directory, 'node_modules/typescript')
    )
    symlinkSync(join(repositoryRoot, 'node_modules/.bin'), join(directory, 'node_modules/.bin'))
    // The server module the joined acceptance imports, and the modules it imports.
    mkdirSync(join(directory, 'apps/web/src/server'), { recursive: true })
    mkdirSync(join(directory, 'apps/web/src/lib'), { recursive: true })
    for (const file of [
      'apps/web/src/server/sim-launch-service.ts',
      'apps/web/src/server/sim-entitlement.ts',
      'apps/web/src/lib/sim-host-contract.ts',
    ]) {
      copyFileSync(join(repositoryRoot, file), join(directory, file))
    }

    const module = join(directory, 'apps/web/src/server/sim-launch-service.ts')
    // Nothing is compiled yet, so the import the lane depends on cannot resolve.
    expect(existsSync(join(directory, 'packages/spatial/dist/sim-bridge/index.js'))).toBe(false)
    expect(resolvesUnderLaneConditions(module, directory)).toBe(false)

    // The lane's build prerequisite produces the compiled entry the export map names.
    const build = spawnSync('bun', ['run', '--cwd', join(directory, 'packages/spatial'), 'build'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 300_000,
    })
    expect(build.status, build.stderr).toBe(0)
    expect(existsSync(join(directory, 'packages/spatial/dist/sim-bridge/index.js'))).toBe(true)

    // And the server module now resolves the compiled Sim bridge.
    expect(resolvesUnderLaneConditions(module, directory)).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 300_000)
