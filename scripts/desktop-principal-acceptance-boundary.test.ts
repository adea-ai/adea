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
