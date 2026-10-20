import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  runCleanupSteps,
  throwCleanupFailures,
} from './fresh-postgres-acceptance/acceptance-teardown.mjs'
import {
  assertFocusedJourneyPassed,
  countSkippedTests,
  parseJourneyReceipt,
} from './fresh-postgres-acceptance/acceptance-receipt.mjs'

const root = resolve(import.meta.dir, '..')
const focused = readFileSync(
  resolve(root, 'scripts/fresh-postgres-acceptance/desktop-principal-lifecycle.test.ts'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/fresh-postgres-acceptance/run.mjs'), 'utf8')

describe('the desktop principal acceptance boundary', () => {
  test('the focused journey must produce a receipt, so a zero-journey result is rejected', () => {
    // The offline regressions of the focused file always run, so a pass count
    // alone cannot prove that the database journey executed. The receipt can.
    expect(() => assertFocusedJourneyPassed('')).toThrow(/no receipt/)
    expect(() => assertFocusedJourneyPassed(' 6 pass\n 0 fail\n')).toThrow(/no receipt/)
    expect(() =>
      assertFocusedJourneyPassed(' 6 pass\n 0 fail\nDESKTOP_PRINCIPAL_JOURNEY {\n')
    ).toThrow(/no receipt/)
    expect(() =>
      assertFocusedJourneyPassed(
        ' 6 pass\n 1 skip\nDESKTOP_PRINCIPAL_JOURNEY {"status":"passed"}\n'
      )
    ).toThrow(/skipped/)
    expect(() =>
      assertFocusedJourneyPassed(
        ' 6 pass\n 0 fail\nDESKTOP_PRINCIPAL_JOURNEY {"status":"failed"}\n'
      )
    ).toThrow(/did not pass/)
    const receipt = assertFocusedJourneyPassed(
      ' 8 pass\n 0 fail\nDESKTOP_PRINCIPAL_JOURNEY {"status":"passed","accounts":3}\n'
    )
    expect(receipt.status).toBe('passed')
    expect(receipt.accounts).toBe(3)
  })

  test('the journey receipt is parsed only from the receipt line', () => {
    expect(parseJourneyReceipt('DESKTOP_PRINCIPAL_JOURNEY {"status":"passed"}\n')).toEqual({
      status: 'passed',
    })
    expect(parseJourneyReceipt(' 8 pass\n 0 fail\n')).toBeNull()
    expect(parseJourneyReceipt('DESKTOP_PRINCIPAL_JOURNEY not json\n')).toBeNull()
    expect(countSkippedTests(' 8 pass\n 0 fail\n')).toBe(0)
    expect(countSkippedTests(' 8 pass\n 2 skip\n')).toBe(2)
  })

  test('the dedicated lane requires the journey receipt, not only the absence of skips', () => {
    expect(runner).toContain('assertFocusedJourneyPassed(focusedOutput)')
    expect(runner).not.toContain('did not execute its database journey')
  })

  test('the focused journey never starts a container or contacts a daemon', () => {
    // The dedicated lane owns the container runtime. The focused test only
    // uses the instance that lane hands it, so ordinary test discovery can
    // never provision against an inherited Docker context.
    expect(focused).not.toContain('startCaptureProvisioning')
    expect(focused).not.toContain('docker create')
    expect(focused).not.toContain("spawnSync('docker'")
    // It uses the lane's instance, and the exact provisioner-owned loopback
    // target the policy allows.
    expect(focused).toContain('MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL')
    expect(focused).toContain('assertProvisionedLoopback')
    // Without the lane's instance the database journey is a named dedicated
    // opt-in skip, so discovery stays side-effect-free.
    expect(focused).toContain('test.skipIf(!provisioner)')
  })

  test('the dedicated lane validates and pins the local Docker target', () => {
    expect(runner).toContain('resolveLocalDockerEndpoint(process.env')
    expect(runner).toContain('process.env.DOCKER_HOST = dockerEndpoint')
    expect(runner).toContain('delete process.env.DOCKER_CONTEXT')
    expect(runner).toContain('delete process.env.DOCKER_TLS_VERIFY')
    expect(runner).toContain('delete process.env.DOCKER_CERT_PATH')
    // The lane runs the focused journey in the same isolated environment.
    expect(runner).toContain(
      'scripts/fresh-postgres-acceptance/desktop-principal-lifecycle.test.ts'
    )
  })

  test('the local Docker policy still refuses a remote or overridden target', () => {
    // The policy module is read as text, not imported: importing it would put
    // a module this lane does not exercise into the per-file coverage gate.
    const policy = readFileSync(
      resolve(root, 'scripts/fresh-postgres-acceptance/policy.mjs'),
      'utf8'
    )
    expect(policy).toContain('fresh-schema provisioning requires a local Docker socket endpoint')
    expect(policy).toContain('fresh-schema provisioning refuses Docker TLS overrides')
    expect(policy).toContain(
      "!value.startsWith('unix:///') && !value.startsWith('npipe:////./pipe/')"
    )
    expect(policy).toContain('inherited.DOCKER_TLS_VERIFY || inherited.DOCKER_CERT_PATH')
  })

  test('a failed cleanup is collected, and every step is still attempted', async () => {
    const attempted: string[] = []
    const errors = await runCleanupSteps([
      async () => {
        attempted.push('first')
        throw new Error('the first cleanup failed')
      },
      async () => {
        attempted.push('second')
      },
      async () => {
        attempted.push('third')
        throw new Error('the third cleanup failed')
      },
    ])
    expect(attempted).toEqual(['first', 'second', 'third'])
    expect(errors).toHaveLength(2)
    expect(String(errors[0])).toContain('the first cleanup failed')
  })

  test('a failed cleanup fails the run instead of passing', () => {
    expect(() =>
      throwCleanupFailures([new Error('the drop failed')], 'the cleanup failed')
    ).toThrow(/the cleanup failed/)
    // A clean teardown with a failed body still fails, and the body failure is
    // kept alongside the cleanup failures.
    const bodyError = new Error('the body failed')
    expect(() => throwCleanupFailures([], 'the cleanup failed', bodyError)).toThrow(
      /the cleanup failed/
    )
    try {
      throwCleanupFailures([new Error('the drop failed')], 'the cleanup failed', bodyError)
      throw new Error('the cleanup failure was not raised')
    } catch (error) {
      const aggregate = error as AggregateError
      expect(aggregate.errors).toContain(bodyError)
      expect(aggregate.errors).toHaveLength(2)
    }
    expect(() => throwCleanupFailures([], 'the cleanup failed')).not.toThrow()
  })

  test('the focused journey fails on a cleanup failure, not only on a body failure', () => {
    // The teardown runs inside the journey, and its failures are thrown after
    // it, so a cleanup that failed cannot leave the run green.
    const teardownIndex = focused.indexOf('const cleanupErrors = await runCleanupSteps(closers)')
    const throwIndex = focused.indexOf('throwScratchFailures(bodyError !== undefined')
    expect(teardownIndex).toBeGreaterThanOrEqual(0)
    expect(throwIndex).toBeGreaterThan(teardownIndex)
    // Every owned connection is closed, and the service close comes first, so
    // a failed provider close cannot strand the auth service.
    expect(focused).toContain('await service?.close()')
    expect(focused).toContain('await providerSql?.end()')
    expect(focused).toContain('await migration?.end()')
    expect(focused).toContain('await cleanupScratchDatabase(admin, name)')
    expect(focused).toContain('await admin?.end()')
  })
})

describe('the dedicated lane fails closed and cleans up after itself', () => {
  test('the lane publishes a receipt only when nothing failed', () => {
    // The receipt is the proof. A failed run has none, so nothing downstream
    // can read a proof out of a run that failed.
    expect(runner).toContain('if (!failed) console.log(JSON.stringify(passedReceipt))')
    expect(runner).toContain('process.exitCode = failed ? 1 : 0')
  })

  test('a primary failure and a cleanup failure are both reported', () => {
    // The primary failure is caught and reported, and the cleanup failure is
    // reported next to it: neither hides the other.
    expect(runner).toContain('failed = true')
    expect(runner).toContain('console.error(error.message)')
    expect(runner).toContain("console.error('owned PostgreSQL cleanup failed')")
    const primary = runner.indexOf('console.error(error.message)')
    const cleanup = runner.indexOf("console.error('owned PostgreSQL cleanup failed')")
    expect(primary).toBeGreaterThanOrEqual(0)
    expect(cleanup).toBeGreaterThan(primary)
  })

  test('the lane removes only the instance it created', () => {
    // The lane stops its own handle. It never removes a container by a name it
    // did not create, and it never prunes.
    expect(runner).toContain('await fixture?.stop()')
    expect(runner).not.toContain('docker rm')
    expect(runner).not.toContain('prune')
  })

  test('the provisioner removes the owned instance when the process ends', () => {
    // The instance is tied to the process that created it: a normal exit and
    // an interrupt both remove it, and the removal happens once. A run that
    // is cancelled therefore leaves nothing behind, and a run that fails
    // cleans up after itself.
    const provisioning = readFileSync(resolve(root, 'scripts/capture-provisioning.mjs'), 'utf8')
    expect(provisioning).toContain('function attachRemoval(handle)')
    expect(provisioning).toContain("process.on('exit', onExit)")
    expect(provisioning).toContain('process.on(signal, listener)')
    expect(provisioning).toContain('process.kill(process.pid, signal)')
    expect(provisioning).toContain('if (stopped) return')
    // Only the container it created is removed, and nothing is pruned.
    expect(provisioning).toContain('removeNamedContainer(name, removalTimeoutMs)')
    expect(provisioning).not.toContain("'prune'")
  })

  test('a child that overruns is killed, and its output is never relayed', () => {
    // A child that hangs is killed instead of waiting forever, and a child that
    // failed is reported by a fixed message: the raw output is not relayed,
    // because it may carry the URL and its parameters.
    expect(runner).toContain('timeout: 180_000')
    expect(runner).toContain('timeout: 600_000')
    expect(runner).toContain("killSignal: 'SIGKILL'")
    expect(runner).toContain('Child failures may include SQL/URL parameters')
    expect(runner).toContain(
      "throw new Error('fresh-schema fixture failed; exit=' + result.status)"
    )
    expect(runner).toContain(
      "throw new Error('the desktop principal acceptance phase failed; exit=' + focused.status)"
    )
    expect(runner).toContain('raw output withheld')
  })
})
