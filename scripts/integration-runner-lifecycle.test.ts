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
  mode?: string
  claimRefused?: string
  foreignLabel?: boolean
  removalFails?: boolean
  admissionRefused?: boolean
  inventory?: boolean
  sharedClaimRefused?: string
  leaseRefused?: string
  releaseRefused?: string
  releaseThrows?: boolean
  removalUnconfirmed?: boolean
}) {
  const child = `
    import vm from 'node:vm'
    import { readFileSync } from 'node:fs'
    import { resolve } from 'node:path'
    const options = ${JSON.stringify(options)}
    const calls = []
    const databaseEnvironments = []
    const receipts = []
    const claims = []
    const sharedClaims = []
    const logs = []
    const removed = new Set()
    let created = false
    const listeners = new Map()
    const errors = []
    const fakeProcess = {
      on(name, listener) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set) },
      off(name, listener) { listeners.get(name)?.delete(listener) },
      kill(pid, signal) { calls.push(['signal', signal]) },
      // A dry run ends the runner. The sentinel stops the evaluation, so the
      // harness can tell an exit apart from a failure.
      exit(code) { calls.push(['exit', String(code)]); throw new Error('__exited__') },
      pid: 123,
    }
    const context = vm.createContext({
      AbortController,
      console: { log(...args) { logs.push(args.join(' ')) }, warn() {}, error(message) { errors.push(message) } },
      process: {
        ...fakeProcess,
        env: {
          ...(options.explicit ? { DATABASE_URL: 'synthetic', DATABASE_URL_UNPOOLED: 'synthetic', DATABASE_MIGRATION_URL: 'synthetic' } : {}),
          ...(options.port !== undefined ? { ADEA_POSTGRES_PORT: options.port } : {}),
          ...(options.mode !== undefined ? { ADEA_INTEGRATION_RESOURCE_MODE: options.mode } : {}),
          ADEA_INTEGRATION_LEASE_DIR: '/synthetic/leases',
          ADEA_INTEGRATION_RUN_ID: 'synthetic-run',
        },
        argv: ['node', 'test-integration.mjs', ...(options.inventory ? ['--inventory'] : [])],
        stdout: { write() {} }, stderr: { write() {} },
      },
    })
    const stub = exports => new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
    const syntheticIdentity = mode => ({
      mode,
      label: mode === 'reusable' ? 'adea-integration-reusable:agent-hq' : 'adea-integration-disposable:adea-int-d-synthetictoken',
      project: mode === 'reusable' ? 'agent-hq' : 'adea-int-d-synthetictoken',
      container: mode === 'reusable' ? 'agent-hq-postgres-1' : 'adea-int-d-synthetictoken-postgres-1',
      volume: mode === 'reusable' ? 'agent-hq_agent-hq-postgres-data' : 'adea-int-d-synthetictoken_agent-hq-postgres-data',
      network: mode === 'reusable' ? 'agent-hq_default' : 'adea-int-d-synthetictoken_default',
      port: mode === 'reusable' ? '55432' : '20001',
      database: 'agent_hq',
    })
    const dependencies = {
      'node:path': stub({ resolve }),
      'node:os': stub({ homedir: () => '/synthetic', tmpdir: () => '/synthetic' }),
      'node:fs': stub({
        // The disk the lane would create its storage on. The number is
        // synthetic, so the admission is the same on every machine.
        statfsSync() { return { bavail: 250_000, bsize: 4096 } },
      }),
      'node:timers/promises': stub({ setTimeout: async () => {} }),
      'node:child_process': stub({ spawnSync(command, args, configuration) {
        if (configuration?.env?.DATABASE_URL) databaseEnvironments.push(Object.fromEntries(
          ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_MIGRATION_URL'].map(name => [name, configuration.env[name]])
        ))
        calls.push([command, ...args])
        if (command === 'docker' && args.includes('info'))
          return { status: 0, stdout: '/tmp' }
        if (command === 'docker' && args.includes('ps'))
          return { status: 0, stdout: options.runningBefore ? 'postgres\\n' : '' }
        if (command === 'docker' && args.includes('stop') && options.stopFails)
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
        composePostgresImage() { return 'synthetic-unused' }, withComposeImage(env) { return env },
        runWithPullFallback(attempt) { return attempt('synthetic-unused') },
        async captureCommand(command, args, configuration) {
          calls.push([command, ...args, 'port:' + (configuration?.env?.ADEA_POSTGRES_PORT ?? 'none')])
          created = true
          if (options.signal) {
            for (const listener of [...(listeners.get(options.signal) ?? [])]) listener()
            // Model termination: the interrupted startup never resumes.
            throw new Error('synthetic interrupted startup')
          }
          return { status: options.failStart ? 1 : 0, stdout: '', stderr: 'synthetic health failure' }
        },
      }),
      './integration-resource-lease.mjs': stub({
        CLEANUP_DECISION: { remove: 'remove', stop: 'stop', retain: 'retain', refuse: 'refuse' },
        CLEANUP_REFUSAL: {
          active: 'active',
          foreign: 'foreign',
          uncertain: 'uncertain',
          callerOwned: 'caller-owned',
          unsafeArbitration: 'unsafe-arbitration',
        },
        DISK_PRESSURE: { admitted: 'admitted', refused: 'refused' },
        REUSABLE_PORT: '55432',
        RESOURCE_MODE: { reusable: 'reusable', disposable: 'disposable' },
        buildInventory({ resources, identity }) {
          calls.push(['inventory', String(resources.length)])
          return { generatedAt: 0, identity: identity.label, items: resources, counts: {} }
        },
        listLeases() { return [] },
        diskPressureAdmission({ availableBytes }) {
          calls.push(['admission', String(availableBytes)])
          if (options.admissionRefused)
            return { decision: 'refused', reason: 'synthetic disk pressure', availableBytes: availableBytes ?? null }
          return { decision: 'admitted', reason: 'synthetic room', availableBytes: availableBytes ?? null }
        },
        reconcileLeases({ runId, identity }) {
          calls.push(['reconcile', runId])
          return { runId, identity: identity.label, found: [], pruned: [], takenBack: false }
        },
        resolveResourceMode(env) { return env.ADEA_INTEGRATION_RESOURCE_MODE ?? 'disposable' },
        createRunToken() { return 'synthetictoken' },
        currentOwner() { return { pid: 123, hostname: 'synthetic-host', startedAt: 'synthetic-start' } },
        deriveDisposablePort() { return '20001' },
        leaseDirectory(env) { return env.ADEA_INTEGRATION_LEASE_DIR },
        callerIdentity() {
          return {
            mode: 'caller', label: 'caller:127.0.0.1:5432/agent_hq', project: null,
            container: null, volume: null, port: '5432', database: 'agent_hq',
          }
        },
        resourceIdentity({ mode, port }) {
          return { ...syntheticIdentity(mode), port: port ?? (mode === 'reusable' ? '55432' : '20001') }
        },
        claimSharedResource({ resourceKey, runId, identity }) {
          sharedClaims.push({ resourceKey, runId, label: identity.label })
          calls.push(['shared-claim', resourceKey])
          // The refusal applies to the first claim only, so the run's own
          // fallback to an instance of its own can be exercised.
          if (options.sharedClaimRefused && sharedClaims.length === 1)
            return { decision: 'refused', reason: options.sharedClaimRefused, claim: null }
          return {
            decision: 'granted',
            claim: {
              version: 1,
              resourceKey,
              runId,
              identity,
              owner: { pid: 123, hostname: 'synthetic-host', startedAt: null },
              token: '3f2a1b0c-1111-4222-8333-444455556666',
              createdAt: 0,
            },
          }
        },
        releaseSharedResource({ resourceKey, runId, token }) {
          calls.push(['shared-release', resourceKey, token ?? 'none'])
          // The release proves the holder with the token the claim was issued
          // with, exactly as the model does.
          if (token !== '3f2a1b0c-1111-4222-8333-444455556666')
            return { released: false, reason: 'the release presented no valid token' }
          if (options.releaseThrows) throw new Error('synthetic release failure')
          if (options.releaseRefused)
            return { released: false, reason: 'synthetic release refusal' }
          return { released: true }
        },
        processIsAlive() { return true },
        runTokenFor(runId) {
          return runId ? String(runId).toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'synthetictoken'
        },
        claimResource({ mode, identity }) {
          claims.push({ mode, label: identity.label })
          calls.push(['claim', mode])
          if (options.leaseRefused)
            return { decision: 'refused', reason: options.leaseRefused, lease: null }
          if (options.claimRefused) return { decision: 'refused', reason: options.claimRefused, lease: null }
          return {
            decision: 'granted', reason: 'claimed',
            lease: {
              version: 1, runId: 'synthetic-run', mode, identity,
              owner: { pid: 123, hostname: 'synthetic-host', startedAt: 'synthetic-start' },
              state: 'claimed', createdAt: 0, updatedAt: 0, cleanup: null,
            },
          }
        },
        planCleanup({ lease, ownership, startedByThisRun }) {
          const identity = lease.identity
          if (ownership === 'caller') {
            return { decision: 'refuse', reason: 'caller-owned', resources: [] }
          }
          const data = [
            { kind: 'database', name: identity.database, action: 'removed', reason: 'synthetic', verifiedAbsent: null },
            { kind: 'data', name: identity.database + ' data', action: 'removed', reason: 'synthetic', verifiedAbsent: null },
          ]
          const checkout = [
            { kind: 'worktree', name: '/synthetic/checkout', action: 'retained', reason: 'synthetic', verifiedAbsent: null },
          ]
          if (lease.mode === 'reusable') {
            return {
              decision: 'stop',
              reason: startedByThisRun ? 'reusable-instance-stopped' : 'reusable-instance-not-owned',
              resources: [
                { kind: 'container', name: identity.container, action: startedByThisRun ? 'stopped' : 'retained', reason: 'synthetic', verifiedAbsent: null },
                { kind: 'volume', name: identity.volume, action: 'retained', reason: 'synthetic', verifiedAbsent: null },
                { kind: 'network', name: identity.network, action: 'retained', reason: 'synthetic', verifiedAbsent: null },
                ...data.map((resource) => ({ ...resource, action: 'retained' })),
                ...checkout,
              ],
            }
          }
          return {
            decision: 'remove', reason: 'disposable-instance-owned-by-this-run',
            resources: [
              { kind: 'container', name: identity.container, action: 'removed', reason: 'synthetic', verifiedAbsent: null },
              { kind: 'volume', name: identity.volume, action: 'removed', reason: 'synthetic', verifiedAbsent: null },
              { kind: 'network', name: identity.network, action: 'removed', reason: 'synthetic', verifiedAbsent: null },
              ...data,
              ...checkout,
            ],
          }
        },
        cleanupReceipt({ lease, decision, reason, resources, child, errors }) {
          const receipt = {
            version: 1, runId: lease.runId, mode: lease.mode, identity: lease.identity,
            decision, reason,
            child: child
              ? { exited: true, status: child.status ?? null, signal: child.signal ?? null }
              : { exited: false, status: null, signal: null },
            resources,
            removed: resources
              .filter((r) => r.action === 'removed' && r.verifiedAbsent === true)
              .map((r) => r.name),
            stopped: resources.filter((r) => r.action === 'stopped').map((r) => r.name),
            retained: resources.filter((r) => r.action === 'retained').map((r) => r.name),
            refused: resources.filter((r) => r.action === 'refused').map((r) => r.name),
            unknown: resources
              .filter(
                (r) => r.action === 'unknown' || (r.action === 'removed' && r.verifiedAbsent !== true)
              )
              .map((r) => r.name),
            errors: errors ?? [],
          }
          receipts.push(receipt)
          return receipt
        },
        releaseLease({ receipt }) { calls.push(['release-lease', receipt.decision]); return receipt },
        summariseReceipt(receipt) { return 'decision=' + receipt.decision },
      }),
      './disposable-postgres-volume-cleanup.mjs': stub({
        runBounded(command, args) {
          calls.push([command, ...args])
          if (args.includes('--format')) {
            // The Compose project label is the ownership proof.
            return { status: 0, stdout: options.foreignLabel ? 'another-project' : 'adea-int-d-synthetictoken', stderr: '', timedOut: false }
          }
          if (args[0] === 'volume' && args[1] === 'inspect') {
            const name = args[args.length - 1]
            return removed.has(name)
              ? { status: 1, stdout: '', stderr: 'no such volume', timedOut: false }
              : { status: 0, stdout: '', stderr: '', timedOut: false }
          }
          if (args[0] === 'network' && args[1] === 'inspect') {
            const name = args[args.length - 1]
            if (options.removalUnconfirmed) {
              // The daemon could not answer, so the state is unknown.
              return { status: 1, stdout: '', stderr: 'cannot connect to the Docker daemon', timedOut: false }
            }
            return removed.has(name)
              ? { status: 1, stdout: '', stderr: 'network not found', timedOut: false }
              : { status: 0, stdout: '', stderr: '', timedOut: false }
          }
          if (args[0] === 'network' && args[1] === 'rm') {
            removed.add(args[2])
            return { status: 0, stdout: '', stderr: '', timedOut: false }
          }
          if (args[0] === 'inspect') {
            const name = args[args.length - 1]
            return removed.has(name)
              ? { status: 1, stdout: '', stderr: 'no such container', timedOut: false }
              : { status: 0, stdout: '', stderr: '', timedOut: false }
          }
          if (args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm')) {
            const name = args[args.length - 1]
            if (options.removalFails) return { status: 1, stdout: '', stderr: 'synthetic removal failure', timedOut: false }
            removed.add(name)
            return { status: 0, stdout: '', stderr: '', timedOut: false }
          }
          return { status: 0, stdout: '', stderr: '', timedOut: false }
        },
        cleanupOwnedResources({ containers, volumes, removeContainer, run }) {
          const failures = []
          const gone = []
          for (const name of containers) {
            const state = run(['inspect', name])
            if (state.status !== 0 && /no such container/.test(state.stderr)) { gone.push(name); continue }
            const removal = run(removeContainer(name))
            if (removal.status !== 0) { failures.push('removing ' + name + ' failed'); continue }
            gone.push(name)
          }
          for (const name of volumes) {
            const state = run(['volume', 'inspect', name])
            if (state.status !== 0 && /no such volume/.test(state.stderr)) { gone.push(name); continue }
            const removal = run(['volume', 'rm', name])
            if (removal.status !== 0) { failures.push('removing ' + name + ' failed'); continue }
            gone.push(name)
          }
          const remaining = []
          for (const name of containers) {
            const state = run(['inspect', name])
            if (!(state.status !== 0 && /no such container/.test(state.stderr))) remaining.push(name)
          }
          for (const name of volumes) {
            const state = run(['volume', 'inspect', name])
            if (!(state.status !== 0 && /no such volume/.test(state.stderr))) remaining.push(name)
          }
          if (options.removalUnconfirmed) {
            // The absence could not be confirmed, so the resources are still
            // reported as present.
            failures.push('owned resources are still present: ' + [...containers, ...volumes].join(', '))
            return {
              absent: [],
              errors: failures,
              remaining: [...containers, ...volumes],
              removed: [],
            }
          }
          if (remaining.length > 0) failures.push('owned resources are still present: ' + remaining.join(', '))
          return { absent: gone, errors: failures, remaining, removed: gone }
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
    try { await runner.evaluate() } catch (error) { failure = error.message === '__exited__' ? undefined : error.message }
    for (const listener of [...(listeners.get('exit') ?? [])]) listener(failure ? 1 : 0)
    console.log(JSON.stringify({ claims, sharedClaims, created, failure, calls, errors, databaseEnvironments, logs, receipts }))
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
    claims: { mode: string; label: string }[]
    sharedClaims: { resourceKey: string; runId: string; label: string }[]
    databaseEnvironments: Record<string, string>[]
    created: boolean
    failure: string
    calls: string[][]
    errors: string[]
    logs: string[]
    receipts: {
      decision: string
      reason: string | null
      child: { exited: boolean; status: number | null; signal: string | null }
      resources: { kind: string; name: string; action: string; verifiedAbsent: boolean | null }[]
      removed: string[]
      stopped: string[]
      retained: string[]
      refused: string[]
      errors: string[]
    }[]
  }
}

// The lane stops the instance through the project it owns, so the command
// names that project.
const stops = (calls: string[][]) =>
  calls.filter((call) => call.join(' ') === 'docker compose --project-name agent-hq stop postgres')
const removals = (calls: string[][]) =>
  calls.filter(
    (call) =>
      call[0] === 'docker' && (call[1] === 'rm' || (call[1] === 'volume' && call[2] === 'rm'))
  )

test('stops its PostgreSQL startup attempt once when health wait fails after creation', () => {
  const result = exercise({ mode: 'reusable', failStart: true })
  expect(result.created).toBe(true)
  expect(stops(result.calls)).toHaveLength(1)
  expect(result.failure).toContain(
    'docker compose --project-name agent-hq up -d --wait --wait-timeout 30 postgres failed with exit code 1'
  )
})

test('stops its PostgreSQL once after successful startup and downstream failure', () => {
  const result = exercise({ mode: 'reusable', failStart: false })
  expect(result.created).toBe(true)
  expect(stops(result.calls)).toHaveLength(1)
  expect(result.failure).toBe('synthetic downstream failure')
})

test('never starts or stops a pre-existing running PostgreSQL service', () => {
  const result = exercise({ mode: 'reusable', runningBefore: true })
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
    const result = exercise({ mode: 'reusable', failAt, stopFails: true, captureStopFails: true })
    expect(stops(result.calls)).toHaveLength(1)
    expect(result.failure).toContain('failed with exit code 7')
    expect(
      result.errors.some((message) => message.includes('stopping the owned container failed'))
    ).toBe(true)
    expect(result.calls.filter((call) => call[0] === 'capture-stop')).toHaveLength(
      failAt === 'test' ? 1 : 0
    )
  })
}

test('releases a registered capture handle after partial capture startup', () => {
  const result = exercise({ mode: 'reusable', capturePartial: true, captureStopFails: true })
  expect(result.failure).toBe('synthetic partial capture failure')
  expect(stops(result.calls)).toHaveLength(1)
  expect(result.calls.filter((call) => call[0] === 'capture-stop')).toHaveLength(1)
})

test('successful tests release both resources exactly once', () => {
  const result = exercise({ mode: 'reusable', success: true })
  expect(result.failure).toBeUndefined()
  expect(stops(result.calls)).toHaveLength(1)
  expect(result.calls.filter((call) => call[0] === 'capture-stop')).toHaveLength(1)
})

for (const options of [{ stopFails: true }, { captureStopFails: true }]) {
  test(`teardown failure fails an otherwise successful run: ${JSON.stringify(options)}`, () => {
    const result = exercise({ mode: 'reusable', success: true, ...options })
    expect(result.failure).toContain(
      options.stopFails ? 'stopping the owned container failed' : 'capture removal failure'
    )
    expect(stops(result.calls)).toHaveLength(1)
    expect(result.calls.filter((call) => call[0] === 'capture-stop')).toHaveLength(1)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} during asynchronous startup stops the owned service once and re-raises`, () => {
    const result = exercise({ mode: 'reusable', signal })
    expect(stops(result.calls)).toHaveLength(1)
    expect(result.calls.filter((call) => call[0] === 'signal')).toEqual([['signal', signal]])
  })
}

test('signalled test child retains its signal in the primary error', () => {
  const result = exercise({
    mode: 'reusable',
    failAt: 'test',
    childSignal: 'SIGTERM',
    stopFails: true,
  })
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
  // The ownership model and the scoped teardown are the production modules, so
  // the runner under test decides for itself what it owns and what it removes.
  for (const module of [
    'integration-resource-lease.mjs',
    'disposable-postgres-volume-cleanup.mjs',
  ]) {
    writeFileSync(join(scripts, module), readFileSync(new URL(module, import.meta.url)))
  }
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
  const state = join(directory, 'state')
  mkdirSync(state)
  // The fake Docker answers the ownership question the runner asks: a resource
  // carries the Compose project it was created for. The project is derived from
  // the resource's own name, the way Compose derives it. A resource that was
  // removed reads as absent afterwards.
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
    echo "docker $*" >> "$FIXTURE_CALLS"
    if [ "$1" = "info" ]; then echo "/tmp"; exit 0; fi
    if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then
      if [ "$3" = "--format" ]; then
        echo "\${5%_default}"
        exit 0
      fi
      if [ -f "${state}/removed-$3" ]; then echo "Error response from daemon: network $3 not found" >&2; exit 1; fi
      exit 0
    fi
    if [ "$1" = "network" ] && [ "$2" = "rm" ]; then : > "${state}/removed-$3"; exit 0; fi
    if [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then
      case "$3" in
        *com.docker.compose.project*)
          echo "\${4%-postgres-1}"
          exit 0
          ;;
      esac
      echo '[{"Type":"volume","Name":"synthetic-anonymous-volume","Destination":"/var/lib/postgresql"}]'
      exit 0
    fi
    if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
      if [ "$3" = "--format" ]; then
        echo "\${5%_agent-hq-postgres-data}"
        exit 0
      fi
      if [ -f "${state}/removed-$3" ]; then echo "Error: no such volume: $3" >&2; exit 1; fi
      exit 0
    fi
    if [ "$1" = "inspect" ]; then
      if [ -f "${state}/removed-$2" ]; then echo "Error response from daemon: No such object: $2" >&2; exit 1; fi
      exit 0
    fi
    if [ "$1" = "rm" ]; then : > "${state}/removed-$3"; exit 0; fi
    if [ "$1" = "volume" ] && [ "$2" = "rm" ]; then : > "${state}/removed-$3"; exit 0; fi
    exit 0
  `,
    { mode: 0o755 }
  )
  for (const command of ['bun', 'node']) {
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
        ADEA_INTEGRATION_LEASE_DIR: join(directory, 'leases'),
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
    const removal = result.calls.findIndex((call) => call.startsWith('docker rm --force'))
    expect(result.calls.indexOf('startup-reaped')).toBeLessThan(removal)
    expect(result.calls).toContain('startup-reaped')
    expect(result.calls.filter((call) => call.startsWith('docker rm --force'))).toHaveLength(1)
  })
}

test('actual Bun runner cleans a failed migration and retains its exit error', async () => {
  const result = await exerciseBun(undefined, true)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('db:verify failed with exit code 7')
  expect(result.calls.filter((call) => call.startsWith('docker rm --force'))).toHaveLength(1)
  expect(result.calls).not.toContain('capture-stop')
})

test('actual Bun runner cleans both fixtures after a successful run', async () => {
  const result = await exerciseBun()
  expect(result.code, result.stderr).toBe(0)
  expect(result.calls.filter((call) => call.startsWith('docker rm --force'))).toHaveLength(1)
  expect(result.calls.filter((call) => call.startsWith('docker volume rm'))).toHaveLength(1)
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
    'integration-resource-lease.mjs',
    'disposable-postgres-volume-cleanup.mjs',
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
      if (args[0] === 'compose' && args.includes('ps')) process.exit(0);
      if (args[0] === 'compose' && args.includes('up')) {
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
      if (args[0] === 'compose' && args.includes('stop')) {
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
      if (args[0] === 'info') { console.log('/tmp'); process.exit(0); }
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (args.includes('--format')) { console.log(args[args.length - 1].replace(/_default$/, '')); process.exit(0); }
        process.exit(1);
      }
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1];
        log('capture-run', name); fs.writeFileSync(resource('capture-resource'), name);
        // The pinned image declares its data directory as a volume, so the instance carries one
        // anonymous volume, the way Docker creates it.
        fs.writeFileSync(resource('capture-volume'), 'synthetic-anonymous-volume');
        console.log('synthetic-container-id'); process.exit(0);
      }
      if (args[0] === 'inspect') {
        if (args.includes('--format')) {
          const format = args[args.indexOf('--format') + 1] ?? '';
          if (format.includes('com.docker.compose.project')) {
            // The Compose project label is the ownership proof the runner reads
            // before it removes anything. Compose derives it from the name.
            console.log(args[args.length - 1].replace(/-postgres-1$/, '')); process.exit(0);
          }
          const name = args[args.length - 1];
          if (!fs.existsSync(resource('capture-resource')) || fs.readFileSync(resource('capture-resource'), 'utf8') !== name) {
            console.error('Error response from daemon: No such object: ' + name); process.exit(1);
          }
          console.log(JSON.stringify([{ Type: 'volume', Name: 'synthetic-anonymous-volume', Destination: '/var/lib/postgresql' }]));
          process.exit(0);
        }
        const name = args[args.length - 1];
        if (!fs.existsSync(resource('capture-resource')) || fs.readFileSync(resource('capture-resource'), 'utf8') !== name) {
          console.error('Error response from daemon: No such object: ' + name); process.exit(1);
        }
        console.log(JSON.stringify([{ Type: 'volume', Name: 'synthetic-anonymous-volume', Destination: '/var/lib/postgresql' }]));
        process.exit(0);
      }
      if (args[0] === 'volume') {
        if (args[1] === 'inspect') {
          const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : '';
          if (format.includes('com.docker.compose.project')) {
            console.log(args[args.length - 1].replace(/_agent-hq-postgres-data$/, '')); process.exit(0);
          }
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
        ADEA_INTEGRATION_LEASE_DIR: join(directory, 'leases'),
        ADEA_INTEGRATION_RESOURCE_MODE: 'reusable',
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
    const captureRemovals = result.events.filter(({ event }) => event === 'capture-rm')
    if (mode === 'capture-signal') {
      expect(captures).toHaveLength(1)
      expect(captureRemovals.map(({ detail }) => detail)).toEqual(
        captures.map(({ detail }) => detail)
      )
    } else {
      expect(captures).toHaveLength(0)
      expect(captureRemovals).toHaveLength(0)
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
  test(`managed runner uses configured loopback port ${port ?? 'a derived one'} for every database URL`, () => {
    const result = exercise({ port, success: true })
    expect(result.failure).toBeUndefined()
    expect(result.databaseEnvironments.length).toBeGreaterThan(0)
    // An explicit port is the operator's choice. Without one, the port
    // belongs to the run, so two concurrent runs never answer on one port.
    const expected = port ?? '20001'
    for (const environment of result.databaseEnvironments) {
      expect(
        Object.values(environment).every((url) => url.includes(`@127.0.0.1:${expected}/agent_hq?`))
      ).toBe(true)
    }
    // The instance this run created is the instance this run removes.
    expect(removals(result.calls)).toHaveLength(2)
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
  // The shared instance is the reusable one, so a service that was already
  // running under that project belongs to whoever started it.
  const result = exercise({ mode: 'reusable', port: '49982', runningBefore: true, success: true })
  expect(result.failure).toBeUndefined()
  expect(result.created).toBe(false)
  expect(stops(result.calls)).toHaveLength(0)
  expect(result.databaseEnvironments.every((env) => env.DATABASE_URL.includes(':49982/'))).toBe(
    true
  )
})

test('configured local port preserves partial-start cleanup and its primary error', () => {
  const result = exercise({ port: '49983', failStart: true })
  expect(result.failure).toContain(
    'up -d --wait --wait-timeout 30 postgres failed with exit code 1'
  )
  expect(removals(result.calls)).toHaveLength(2)
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
  const provisioning = calls.findIndex((call) => call.startsWith('docker compose --project-name'))
  const suites = calls.findIndex((call) => call.startsWith('bun --conditions=react-server test'))
  expect(build).toBeGreaterThan(-1)
  // The build precedes the provisioning and the suites, so a clean checkout has the compiled
  // entry before any suite can import it. The provisioning and its cleanup are unchanged.
  expect(provisioning).toBeGreaterThan(build)
  expect(suites).toBeGreaterThan(build)
  expect(removals(result.calls)).toHaveLength(2)
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

// The ownership wiring of the lane. These cases run the runner against
// synthetic children and a synthetic Docker, so the claims, the removals and
// the receipts are observed without a daemon, a container or a volume.

test('the lane claims its resource before the instance is started', () => {
  const result = exercise({ success: true })
  const calls = result.calls.map((call) => call.join(' '))
  const claim = calls.findIndex((call) => call.startsWith('claim'))
  const startup = calls.findIndex((call) => call.startsWith('docker compose --project-name'))
  expect(claim).toBeGreaterThan(-1)
  // The ownership record exists before the resource does, so an interrupted
  // run leaves evidence of what it owned.
  expect(startup).toBeGreaterThan(claim)
  expect(result.claims).toEqual([
    { mode: 'disposable', label: 'adea-integration-disposable:adea-int-d-synthetictoken' },
  ])
})

test('the lane names its own project and port in every Compose call', () => {
  const result = exercise({ success: true })
  const composeCalls = result.calls.filter((call) => call[0] === 'docker' && call[1] === 'compose')
  expect(composeCalls.length).toBeGreaterThan(0)
  for (const call of composeCalls) {
    expect(call).toContain('--project-name')
    expect(call).toContain('adea-int-d-synthetictoken')
  }
  // The port belongs to the run, so two concurrent runs never answer on one.
  expect(result.calls.some((call) => call.includes('port:20001'))).toBe(true)
})

test('a disposable run removes only the resources its lease names', () => {
  const result = exercise({ success: true })
  const removed = result.calls.filter(
    (call) =>
      call[0] === 'docker' && (call[1] === 'rm' || (call[1] === 'volume' && call[2] === 'rm'))
  )
  expect(removed).toHaveLength(2)
  expect(removed[0]).toContain('adea-int-d-synthetictoken-postgres-1')
  expect(removed[1]).toContain('adea-int-d-synthetictoken_agent-hq-postgres-data')
  // A blanket teardown of the whole Docker state is never a lane's cleanup.
  expect(result.calls.some((call) => call.join(' ') === 'docker system prune')).toBe(false)
  expect(result.calls.some((call) => call.join(' ') === 'docker compose down -v')).toBe(false)
})

test('a resource that carries another project label is not removed', () => {
  const result = exercise({ success: true, foreignLabel: true })
  expect(result.failure).toContain('does not carry this run')
  // The removal was refused, so no resource was touched.
  expect(
    result.calls.filter(
      (call) =>
        call[0] === 'docker' && (call[1] === 'rm' || (call[1] === 'volume' && call[2] === 'rm'))
    )
  ).toHaveLength(0)
  const receipt = result.receipts.at(-1)
  expect(receipt?.refused).toContain('adea-int-d-synthetictoken-postgres-1')
  expect(receipt?.removed).toEqual([])
  // The data that lives in the volume was not removed either, and the
  // receipt says so rather than claiming a removal that did not happen.
  expect(receipt?.refused).toContain('agent_hq')
})

test('a caller-supplied target is never removed, and the receipt says so', () => {
  const result = exercise({ explicit: true, success: true })
  expect(result.calls.filter((call) => call[0] === 'docker')).toHaveLength(0)
  const receipt = result.receipts.at(-1)
  expect(receipt?.decision).toBe('refuse')
  expect(receipt?.reason).toBe('caller-owned')
  expect(receipt?.removed).toEqual([])
})

test('the receipt separates the child outcome from the fate of the resources', () => {
  const result = exercise({ success: true })
  const receipt = result.receipts.at(-1)
  expect(receipt?.child.exited).toBe(true)
  expect(receipt?.removed).toHaveLength(5)
  // The checkout the run used is named as kept: the lane never removes one.
  expect(receipt?.retained).toContain('/synthetic/checkout')
  expect(receipt?.errors).toEqual([])
})

test('a cleanup that cannot remove everything fails the lane', () => {
  const result = exercise({ success: true, removalFails: true })
  expect(result.failure).toContain('the integration resource cleanup did not complete')
  const receipt = result.receipts.at(-1)
  expect(receipt?.errors.length).toBeGreaterThan(0)
})

test('a shared instance that a live run holds sends this run to an instance of its own', () => {
  const result = exercise({ mode: 'reusable', sharedClaimRefused: 'active', success: true })
  // The shared claim is refused, so the run takes an instance of its own.
  expect(result.sharedClaims.map((claim) => claim.resourceKey)).toEqual([
    'adea-integration-reusable:agent-hq',
    'adea-integration-disposable:adea-int-d-synthetictoken',
  ])
  const composeCalls = result.calls.filter((call) => call[0] === 'docker' && call[1] === 'compose')
  expect(composeCalls.every((call) => call.includes('adea-int-d-synthetictoken'))).toBe(true)
  expect(composeCalls.every((call) => !call.includes('agent-hq'))).toBe(true)
})

test('the shared claim is taken before the run records its lease', () => {
  const result = exercise({ success: true })
  const calls = result.calls.map((call) => call.join(' '))
  const shared = calls.findIndex((call) => call.startsWith('shared-claim'))
  const lease = calls.findIndex((call) => call.startsWith('claim'))
  expect(shared).toBeGreaterThan(-1)
  expect(lease).toBeGreaterThan(shared)
})

test('the shared claim is released with the cleanup', () => {
  const result = exercise({ success: true })
  const calls = result.calls.map((call) => call.join(' '))
  const release = calls.findIndex((call) => call.startsWith('shared-release'))
  expect(release).toBeGreaterThan(-1)
  // The claim is released after the removal, so the next sequential run can
  // take the instance.
  const removal = calls.findIndex((call) => call.startsWith('docker rm'))
  expect(release).toBeGreaterThan(removal)
})

test('a shared instance two runs are contending for sends this run to an instance of its own', () => {
  const result = exercise({
    mode: 'reusable',
    sharedClaimRefused: 'unsafe-arbitration',
    success: true,
  })
  // The shared instance is contested, so the run does not share a database with
  // whoever else is reaching for it.
  expect(result.sharedClaims.map((claim) => claim.resourceKey)).toEqual([
    'adea-integration-reusable:agent-hq',
    'adea-integration-disposable:adea-int-d-synthetictoken',
  ])
  const composeCalls = result.calls.filter((call) => call[0] === 'docker' && call[1] === 'compose')
  expect(composeCalls.every((call) => call.includes('adea-int-d-synthetictoken'))).toBe(true)
})

test('a refused shared claim stops the run before it creates anything', () => {
  const result = exercise({ sharedClaimRefused: 'active', success: true })
  expect(result.failure).toContain('the integration resource is not available')
  const calls = result.calls.map((call) => call.join(' '))
  expect(calls.some((call) => call.startsWith('docker compose'))).toBe(false)
})

test('a shared instance this run started is stopped and kept for the next run', () => {
  const result = exercise({ mode: 'reusable', success: true })
  const receipt = result.receipts.at(-1)
  expect(receipt?.decision).toBe('stop')
  expect(receipt?.stopped).toEqual(['agent-hq-postgres-1'])
  expect(receipt?.retained).toContain('agent-hq_agent-hq-postgres-data')
  expect(receipt?.removed).toEqual([])
  // Nothing is removed in the shared mode: the next sequential run reuses it.
  expect(
    result.calls.filter(
      (call) =>
        call[0] === 'docker' && (call[1] === 'rm' || (call[1] === 'volume' && call[2] === 'rm'))
    )
  ).toHaveLength(0)
})

test('a disk that cannot take the run refuses it before anything is claimed or created', () => {
  const result = exercise({ admissionRefused: true })
  expect(result.failure).toContain('the integration lane was not admitted')
  const calls = result.calls.map((call) => call.join(' '))
  // The admission comes before the claim and before the instance.
  expect(calls.some((call) => call.startsWith('admission'))).toBe(true)
  expect(calls.some((call) => call.startsWith('claim'))).toBe(false)
  expect(calls.some((call) => call.startsWith('docker compose'))).toBe(false)
})

test('the lane reconciles its own records before it claims one', () => {
  const result = exercise({ success: true })
  const calls = result.calls.map((call) => call.join(' '))
  const reconciliation = calls.findIndex((call) => call.startsWith('reconcile'))
  const claim = calls.findIndex((call) => call.startsWith('claim'))
  expect(reconciliation).toBeGreaterThan(-1)
  expect(claim).toBeGreaterThan(reconciliation)
})

test('the dry-run inventory reports what the lane can see and changes nothing', () => {
  const result = exercise({ inventory: true })
  const inventory = JSON.parse(result.logs.join('\n'))
  expect(inventory.identity).toBe('adea-integration-disposable:adea-int-d-synthetictoken')
  // A dry run claims nothing, creates nothing and removes nothing.
  expect(result.calls.some((call) => call[0] === 'claim')).toBe(false)
  expect(result.calls.some((call) => call[0] === 'docker' && call[1] === 'compose')).toBe(false)
  expect(result.receipts).toHaveLength(0)
})

test('a disposable run removes the network with the container and the volume', () => {
  const result = exercise({ success: true })
  const removed = result.calls.filter(
    (call) =>
      call[0] === 'docker' &&
      (call[1] === 'rm' ||
        (call[1] === 'volume' && call[2] === 'rm') ||
        (call[1] === 'network' && call[2] === 'rm'))
  )
  expect(removed).toHaveLength(3)
  expect(removed.some((call) => call.includes('adea-int-d-synthetictoken_default'))).toBe(true)
  const receipt = result.receipts.at(-1)
  expect(receipt?.removed).toContain('adea-int-d-synthetictoken_default')
})

test('the receipt tells a process exit from the containers, volumes, data and checkouts kept', () => {
  const result = exercise({ success: true })
  const receipt = result.receipts.at(-1)
  const kinds = receipt?.resources.map((resource) => resource.kind) ?? []
  expect(kinds).toContain('container')
  expect(kinds).toContain('volume')
  expect(kinds).toContain('network')
  expect(kinds).toContain('database')
  expect(kinds).toContain('data')
  expect(kinds).toContain('worktree')
  // The checkout is kept, and the receipt says so.
  expect(receipt?.retained).toContain('/synthetic/checkout')
  // The child outcome is its own fact.
  expect(receipt?.child.exited).toBe(true)
})

test('a run that fell back to an instance of its own records the mode it ended up in', () => {
  const result = exercise({ mode: 'reusable', sharedClaimRefused: 'active', success: true })
  // The lease records the effective mode, not the mode that was asked for.
  expect(result.claims.map((claim) => claim.mode)).toEqual(['disposable'])
  // And the cleanup removes the instance this run created, instead of keeping
  // the shared one for a run that never had it.
  const receipt = result.receipts.at(-1)
  expect(receipt?.decision).toBe('remove')
  expect(receipt?.removed.length).toBeGreaterThan(0)
  expect(receipt?.retained).not.toContain('agent-hq_agent-hq-postgres-data')
})

test('a removal whose absence could not be confirmed is not reported as removed', () => {
  const result = exercise({ success: true, removalUnconfirmed: true })
  // The lane fails, because a teardown that did not finish is not a clean one.
  expect(result.failure).toContain('the integration resource cleanup did not complete')
  const receipt = result.receipts.at(-1)
  // A removal that was attempted is not a removal that happened.
  expect(receipt?.removed).toEqual([])
  expect(receipt?.unknown.length).toBeGreaterThan(0)
  expect(receipt?.errors.length).toBeGreaterThan(0)
})

test('the release presents the token the claim was issued with', () => {
  const result = exercise({ success: true })
  const release = result.calls.find((call) => call[0] === 'shared-release')
  expect(release).toBeDefined()
  expect(release?.[2]).toBe('3f2a1b0c-1111-4222-8333-444455556666')
  // The claim was not left behind, and the lane did not report a failure over
  // the release.
  expect(result.failure).toBeUndefined()
  expect(result.receipts.at(-1)?.errors).toEqual([])
})

test('a refused per-run lease releases the shared claim with the token it was issued with', () => {
  const result = exercise({ success: true, leaseRefused: 'uncertain' })
  // The run's own record was refused, so the run owns nothing.
  expect(result.failure).toContain('the integration resource is not available: uncertain')
  // The shared claim it had taken is released with the token it was issued
  // with, so the release is a release by the holder.
  const release = result.calls.find((call) => call[0] === 'shared-release')
  expect(release).toBeDefined()
  expect(release?.[2]).toBe('3f2a1b0c-1111-4222-8333-444455556666')
  // The refusal that stopped the run is the one that is reported, and the
  // release did not add a failure of its own.
  expect(result.errors.filter((message) => message.includes('was not released'))).toEqual([])
})

test('a refused release is reported and the original refusal is what stops the run', () => {
  const result = exercise({ success: true, leaseRefused: 'uncertain', releaseRefused: 'synthetic' })
  // The refusal that stopped the run is the one the run reports.
  expect(result.failure).toContain('the integration resource is not available: uncertain')
  // The cleanup failure is reported on its own, and it does not replace that
  // refusal.
  expect(result.errors.some((message) => message.includes('was not released'))).toBe(true)
  expect(result.failure).not.toContain('synthetic release refusal')
})

test('a thrown release is reported and the original refusal still stops the run', () => {
  const result = exercise({ success: true, leaseRefused: 'uncertain', releaseThrows: true })
  // A throw from the cleanup does not become the run's outcome.
  expect(result.failure).toContain('the integration resource is not available: uncertain')
  expect(result.errors.some((message) => message.includes('could not be released'))).toBe(true)
  expect(result.failure).not.toContain('synthetic release failure')
})
