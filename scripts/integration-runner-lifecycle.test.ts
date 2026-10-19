import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const nodePath = Bun.which('node')
if (!nodePath) throw new Error('Node.js is required for the isolated runner VM')
const runnerPath = fileURLToPath(new URL('./test-integration.mjs', import.meta.url))

// Run the production runner in a child VM: all process, Docker, provisioning,
// target and inventory boundaries are synthetic and cannot reach real resources.
function exercise(options: {
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
      console: { log() {}, warn() {}, error(message) { errors.push(message) } },
      process: {
        ...fakeProcess,
        env: options.explicit ? {
          DATABASE_URL: 'synthetic', DATABASE_URL_UNPOOLED: 'synthetic', DATABASE_MIGRATION_URL: 'synthetic',
        } : {},
        argv: ['node', 'test-integration.mjs'],
        stdout: { write() {} }, stderr: { write() {} },
      },
    })
    const stub = exports => new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
    const dependencies = {
      'node:path': stub({ resolve }),
      'node:child_process': stub({ spawnSync(command, args) {
        calls.push([command, ...args])
        if (command === 'docker' && args[1] === 'ps')
          return { status: 0, stdout: options.runningBefore ? 'postgres\\n' : '' }
        if (command === 'docker' && args[1] === 'stop' && options.stopFails)
          return { status: 9 }
        if (args.includes(options.failAt)) return { status: options.childSignal ? null : 7, signal: options.childSignal }
        return { status: 0, stdout: '' }
      } }),
      './test-target-guard.mjs': stub({ assertLocalTestTargets() {} }),
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
    console.log(JSON.stringify({ created, failure, calls, errors }))
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
    export async function captureCommand() {
      log('compose-start');
      if (process.env.FIXTURE_INTERRUPT) {
        writeFileSync(process.env.FIXTURE_READY, 'ready');
        await new Promise(() => { setInterval(() => {}, 1000) });
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
})
