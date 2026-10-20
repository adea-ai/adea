import { describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { gateAcceptanceReceipt, parseAcceptanceReceipt } from './ci-fresh-account-acceptance.mjs'

// The failure and cleanup semantics of the fresh-account acceptance lane, as
// the pull-request lane sees them.
//
// The acceptance lane is the acceptance lane's own: this file does not change
// it, and it does not copy any part of it. It replaces the lane's three seams —
// the provisioner, the fixture and the focused journey — with fakes, so every
// failure path is exercised for real, without a container, and it asserts what
// the pull-request lane is allowed to see: no passed receipt, the primary
// failure and the cleanup failure both reported, the owned resource settled
// and nothing else, and evidence that carries no credential.
//
// The qualification is hermetic. The lane resolves its Docker endpoint before
// it provisions anything, so the run is handed a validated synthetic local
// endpoint, every Docker setting the caller may have is removed, and the
// runner's own Docker is replaced by one that records a call if it ever
// happens. A qualification that depends on the machine's Docker is not a
// qualification.

const lanePath = resolve(import.meta.dir, 'fresh-postgres-acceptance/run.mjs')
const password = 'fake-postgres-password'
const fakeUrl = `postgresql://postgres:${password}@127.0.0.1:5432/postgres?sslmode=disable`
const syntheticDockerEndpoint = 'unix:///tmp/adea-acceptance-fake-docker.sock'

/** How the fakes behave in one run of the lane. */
type Behaviour = {
  provisioning?: 'ok' | 'throws'
  fixture?: 'ok' | 'fails' | 'hangs'
  journey?: 'ok' | 'fails' | 'skips' | 'silent' | 'hangs'
  cleanup?: 'ok' | 'throws'
}

const write = (root: string, path: string, content: string) => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

/**
 * The Docker the lane discovers.
 *
 * The lane reads the selected context's endpoint before it provisions
 * anything, and it refuses an endpoint that is not a local socket. The
 * qualification therefore puts its own Docker first on the path: it answers
 * with a validated synthetic local endpoint and records that it was asked, so
 * the qualification can prove that the runner's own Docker was never
 * consulted.
 */
function dockerShim(bin: string, available: boolean): string {
  mkdirSync(bin, { recursive: true })
  const script = join(bin, 'docker')
  const answer = available
    ? `echo '${JSON.stringify(syntheticDockerEndpoint)}'`
    : `echo 'docker is not available in this qualification' >&2\nexit 1`
  writeFileSync(script, `#!/bin/sh\n: > "\${DOCKER_CALLED_MARKER:-/dev/null}"\n${answer}\n`)
  chmodSync(script, 0o755)
  return bin
}

/**
 * The environment the lane runs in.
 *
 * The lane refuses a TLS or a certificate override and a remote endpoint, so
 * every Docker setting the caller may have is removed and a validated
 * synthetic local endpoint takes its place. The run then depends on nothing
 * outside the checkout it was given.
 */
function laneEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    delete environment[name]
  }
  return { ...environment, DOCKER_HOST: syntheticDockerEndpoint }
}

/**
 * A repository the lane can run against: the lane's own prerequisites, the
 * provisioner, the fixture and the focused journey.
 *
 * It is a git repository with one commit, because the lane names the tree it
 * ran in, and a receipt it publishes has to name a clean tree.
 */
function createFakeRepository(behaviour: Behaviour): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'adea-acceptance-failure-'))
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`)
    }
    return (result.stdout ?? '').trim()
  }

  // The prerequisites the lane checks before it starts a database.
  write(root, 'packages/auth/src/better-auth-server.ts', 'export {}\n')
  write(root, 'packages/auth/src/delivery.ts', 'export {}\n')
  write(
    root,
    'packages/auth/package.json',
    JSON.stringify({ name: 'auth', dependencies: { 'better-auth': '1.0.0', pg: '1.0.0' } })
  )
  write(root, 'scripts/fresh-postgres-acceptance/auth-lifecycle.ts', 'export {}\n')

  // The provisioner. It owns one instance — a real directory, so the
  // qualification sees a real resource settled — and it removes only that one.
  write(
    root,
    'scripts/capture-provisioning.mjs',
    `import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const instance = resolve(root, 'owned-instance')

export function startCaptureProvisioning(register) {
  const handle = {
    containerName: 'adea-capture-prov-fake',
    databaseUrl: ${JSON.stringify(fakeUrl)},
    stop() {
      if (handle.stopped) return
      handle.stopped = true
      ${
        behaviour.cleanup === 'throws'
          ? `// The removal failed: the instance is still there.
      throw new Error('the owned container could not be removed')`
          : `rmSync(instance, { recursive: true, force: true })
      writeFileSync(resolve(root, 'stopped.txt'), handle.containerName)`
      }
    },
  }
  ${
    behaviour.provisioning === 'throws'
      ? "throw new Error('the disposable instance could not start')"
      : `mkdirSync(instance, { recursive: true })
  writeFileSync(resolve(instance, 'marker'), 'the owned instance')
  register(handle)
  // The provisioner owns the instance for the life of the process: a normal
  // exit and an interrupt both remove it, and the removal is idempotent. The
  // handlers are attached before the run is told that it is ready, because a
  // parent may signal the run the moment it is ready.
  process.on('exit', () => {
    try {
      handle.stop()
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  })
  const signalListeners = []
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => {
      for (const [other, otherListener] of signalListeners) process.off(other, otherListener)
      try {
        handle.stop()
      } catch (error) {
        console.error(error.message)
      }
      process.kill(process.pid, signal)
    }
    signalListeners.push([signal, listener])
  }
  for (const [signal, listener] of signalListeners) process.on(signal, listener)
  writeFileSync(resolve(root, 'handlers-attached.txt'), handle.containerName)
  return handle`
  }
}
`
  )

  // The fixture: it applies the schema and prints the receipt the lane reads.
  // It records that it finished, so the qualification can wait for the run's
  // own child before it removes the repository.
  const fixturePrelude = `import { existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// The readiness barrier. The run publishes readiness only after its cleanup
// handlers are attached, and the fixture refuses to start before that, so a
// parent that signals the moment readiness appears always reaches a run that
// can clean up after itself.
if (!existsSync(resolve(root, 'handlers-attached.txt'))) {
  console.error('the run was ready before its cleanup handlers were attached')
  process.exit(1)
}
writeFileSync(resolve(root, 'fixture-ready.txt'), 'ready')
process.on('exit', () => writeFileSync(resolve(root, 'fixture-finished.txt'), 'finished'))
`
  const fixtureBody =
    behaviour.fixture === 'hangs'
      ? 'await new Promise((resolve) => setTimeout(resolve, 4000))'
      : behaviour.fixture === 'fails'
        ? `const line = 'the fixture failed with the secret ${password}\\n'
writeFileSync(resolve(root, 'fixture-output.txt'), line)
process.stderr.write(line)
process.exit(1)`
        : `console.log(
  'FRESH_SCHEMA_ACCEPTANCE ' +
    JSON.stringify({
      status: 'passed',
      migrations: 60,
      desktopPrincipal: {
        accounts: 3,
        exchanges: 1,
        mappedUsers: 3,
        orphanUsers: 0,
        provider: 'better-auth',
        refused: { origin: 1, pkce: 1, replay: 1 },
      },
    })
)`
  write(root, 'scripts/fresh-postgres-acceptance/fixture.ts', `${fixturePrelude}${fixtureBody}\n`)

  // The focused journey: it prints its own receipt, and the lane requires it.
  const journeyPrelude = `import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'bun:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// The journey publishes when it starts and when its tests are done, so the
// qualification knows that it started a child and can wait for that child to
// settle. The test runner does not run an exit handler, so the end of the
// file is the moment the journey publishes its finish.
writeFileSync(resolve(root, 'journey-ready.txt'), 'ready')
afterAll(() => writeFileSync(resolve(root, 'journey-finished.txt'), 'finished'))
`
  const journeyBody =
    behaviour.journey === 'skips'
      ? "test.skip('the journey did not run', () => {})"
      : behaviour.journey === 'fails'
        ? "test('the journey failed', () => { throw new Error('the journey failed') })"
        : behaviour.journey === 'silent'
          ? "test('the journey ran without a receipt', () => {})"
          : behaviour.journey === 'hangs'
            ? "test('the journey is still running', async () => { await new Promise((settled) => setTimeout(settled, 3000)) })"
            : `test('the journey ran', () => {
  console.log(
    'DESKTOP_PRINCIPAL_JOURNEY ' +
      JSON.stringify({
        status: 'passed',
        accounts: 3,
        mappedUsers: 3,
        orphanUsers: 0,
        provider: 'better-auth',
        desktopSessions: 1,
        exchanges: 1,
        refused: { origin: 1, pkce: 1, replay: 1 },
      })
  )
})`
  write(
    root,
    'scripts/fresh-postgres-acceptance/desktop-principal-lifecycle.test.ts',
    `import { test } from 'bun:test'\n\n${journeyPrelude}\n${journeyBody}\n`
  )

  git(['init', '-q'])
  git(['add', '-A'])
  git([
    '-c',
    'user.name=synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'synthetic',
  ])
  return { root, sha: git(['rev-parse', 'HEAD']) }
}

type LaneRun = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  // The temporary Docker the qualification handed the run, so the
  // qualification can show that it removed it.
  shimDirectory: string
}

/** Runs the lane against a fake repository and collects what it printed. */
async function runLane(
  root: string,
  options: {
    killWhenReady?: 'fixture' | 'journey'
    signal?: NodeJS.Signals
    environment?: Record<string, string>
    override?: Record<string, string>
    docker?: 'available' | 'unavailable'
  } = {}
): Promise<LaneRun> {
  const binDirectory = mkdtempSync(join(tmpdir(), 'adea-acceptance-bin-'))
  const bin = dockerShim(binDirectory, options.docker !== 'unavailable')
  const marker = join(root, 'docker-was-called.txt')
  const child = spawn('node', [lanePath, '--repository', root], {
    encoding: 'utf8',
    env: {
      ...laneEnvironment({
        ...options.environment,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        DOCKER_CALLED_MARKER: marker,
      }),
      // Settings the caller insists on, applied after the exclusion, so the
      // lane's own refusal of a hostile one can be seen.
      ...options.override,
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk
  })
  // The run is settled when its output is closed, not only when the process
  // ends: a child the run left behind still holds the output open.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.on('error', (error) => rejectExit(error))
      child.on('close', (code, signal) => resolveExit({ code, signal }))
    }
  )
  if (options.killWhenReady) {
    // The signal reaches a run that is ready: its cleanup handlers are
    // attached and its instance exists, so the qualification sees the cleanup
    // of an instance that really existed. The barrier is the child's own
    // start, so the run is inside it when the signal arrives.
    const ready = join(root, `${options.killWhenReady}-ready.txt`)
    for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) {
      await new Promise((settled) => setTimeout(settled, 50))
    }
    child.kill(options.signal ?? 'SIGTERM')
  }
  const { code, signal } = await exited
  // The Docker the qualification handed the run is the qualification's own
  // temporary resource, and it is removed once the run has ended.
  rmSync(binDirectory, { recursive: true, force: true })
  return { code, signal, stdout, stderr, shimDirectory: binDirectory }
}

/**
 * Waits, for a bounded time, for the children the run actually started.
 *
 * A child that published its readiness started, and it has settled when it
 * published its finish. A child that never started is not waited for, and a
 * child that is still running keeps the repository it is writing into: the
 * answer is then false, and the caller keeps the repository instead of
 * removing it under a live child.
 */
async function settleChildren(root: string, timeoutMs = 20_000): Promise<boolean> {
  const started = (['fixture', 'journey'] as const).filter((child) =>
    existsSync(join(root, `${child}-ready.txt`))
  )
  if (started.length === 0) return true
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const allSettled = started.every((child) => existsSync(join(root, `${child}-finished.txt`)))
    if (allSettled) return true
    if (Date.now() > deadline) return false
    await new Promise((settled) => setTimeout(settled, 50))
  }
}

/** The receipt the lane printed, or null when it printed none. */
function printedReceipt(run: LaneRun): Record<string, unknown> | null {
  try {
    return parseAcceptanceReceipt(run.stdout)
  } catch {
    return null
  }
}

/** The instance the run created, and the only one it was allowed to remove. */
function ownedInstanceExists(fake: { root: string }): boolean {
  return existsSync(join(fake.root, 'owned-instance'))
}

/**
 * The run removed its own instance and nothing else.
 *
 * The provisioner records the container it stopped, and the instance it
 * created is a real directory, so the qualification sees a real resource
 * settled.
 */
function expectOwnedInstanceRemoved(fake: { root: string }) {
  expect(readFileSync(join(fake.root, 'stopped.txt'), 'utf8')).toBe('adea-capture-prov-fake')
  expect(ownedInstanceExists(fake)).toBe(false)
}

const withFakeRepository = async (
  behaviour: Behaviour,
  body: (fake: { root: string; sha: string }) => Promise<void>,
  options: { settlementTimeoutMs?: number } = {}
): Promise<{ settled: boolean }> => {
  const fake = createFakeRepository(behaviour)
  let failure: unknown
  try {
    await body(fake)
  } catch (error) {
    failure = error
  }
  // The repository is removed only after every child the run started has
  // settled. A child that is still running keeps the repository it writes
  // into: the qualification fails and the repository is preserved, rather
  // than being removed under a live child.
  const settled = await settleChildren(fake.root, options.settlementTimeoutMs)
  if (settled) {
    rmSync(fake.root, { recursive: true, force: true })
  } else if (!failure) {
    failure = new Error(
      `the run's children did not settle; the repository was preserved at ${fake.root}`
    )
  }
  if (failure) throw failure
  return { settled }
}

describe('the acceptance lane fails closed', () => {
  test('a setup failure publishes no receipt', async () => {
    await withFakeRepository({ provisioning: 'throws' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
      expect(run.stderr).toContain('the disposable instance could not start')
      // The instance was never created, so there was nothing to remove.
      expect(ownedInstanceExists(fake)).toBe(false)
    })
  }, 30_000)

  test('a migration failure publishes no receipt', async () => {
    await withFakeRepository({ fixture: 'fails' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
      expect(run.stderr).toContain('fresh-schema fixture failed')
      expectOwnedInstanceRemoved(fake)
    })
  }, 30_000)

  test('a test failure publishes no receipt', async () => {
    await withFakeRepository({ journey: 'fails' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
      expect(run.stderr).toContain('the desktop principal acceptance phase failed')
      expectOwnedInstanceRemoved(fake)
    })
  }, 30_000)

  test('a skipped journey publishes no receipt', async () => {
    await withFakeRepository({ journey: 'skips' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stderr).toContain('skipped 1 test(s)')
      expectOwnedInstanceRemoved(fake)
    })
  }, 30_000)

  test('a journey that printed no receipt publishes no receipt', async () => {
    await withFakeRepository({ journey: 'silent' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stderr).toContain('produced no receipt')
      expectOwnedInstanceRemoved(fake)
    })
  }, 30_000)

  test('a cleanup failure publishes no receipt and is reported', async () => {
    await withFakeRepository({ cleanup: 'throws' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stderr).toContain('owned PostgreSQL cleanup failed')
      // The removal was attempted for the owned instance and it failed, so the
      // instance is still there: this is the leak the pull-request lane's
      // check reports by name.
      expect(ownedInstanceExists(fake)).toBe(true)
    })
  }, 30_000)

  test('a primary failure and a cleanup failure are both reported', async () => {
    await withFakeRepository({ fixture: 'fails', cleanup: 'throws' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      // The primary failure is not hidden by the cleanup failure, and the
      // cleanup failure is not hidden by the primary one.
      expect(run.stderr).toContain('fresh-schema fixture failed')
      expect(run.stderr).toContain('owned PostgreSQL cleanup failed')
      expect(ownedInstanceExists(fake)).toBe(true)
    })
  }, 30_000)

  test('an interrupted run publishes no receipt and settles its own instance', async () => {
    await withFakeRepository({ fixture: 'hangs' }, async (fake) => {
      const run = await runLane(fake.root, { killWhenReady: 'fixture', signal: 'SIGTERM' })
      // The interrupt does not let the run succeed, whichever way the process
      // ends: the run reports the failure and exits with it.
      expect(run.code).not.toBe(0)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
      // The provisioner owns the instance for the life of the process, so the
      // run removes it before it ends, and a cancelled run leaves nothing
      // behind.
      expectOwnedInstanceRemoved(fake)
      // The run's own child finished, and the output the run produced is
      // complete.
      expect(await settleChildren(fake.root)).toBe(true)
    })
  }, 40_000)

  test('a run the runner destroyed publishes no receipt and settles nothing', async () => {
    await withFakeRepository({ fixture: 'hangs' }, async (fake) => {
      const run = await runLane(fake.root, { killWhenReady: 'fixture', signal: 'SIGKILL' })
      expect(run.signal).toBe('SIGKILL')
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
      // A killed process runs no finally block: it cannot settle the instance
      // it owned, and nothing in it may claim that it did. The runner's own
      // teardown is what ends the instance, and the pull-request lane's check
      // reports it by name if it outlives the run. The cleanup qualification
      // for a destroyed run therefore stays pending.
      expect(ownedInstanceExists(fake)).toBe(true)
      // The run's own child still finished, and the qualification waited for
      // it before the repository was removed.
      expect(await settleChildren(fake.root)).toBe(true)
    })
  }, 40_000)

  test('the run publishes readiness only after its cleanup handlers are attached', async () => {
    await withFakeRepository({ fixture: 'hangs' }, async (fake) => {
      const run = await runLane(fake.root, { killWhenReady: 'fixture', signal: 'SIGTERM' })
      // The fixture refuses to start before the handlers are attached, so the
      // readiness it publishes can only exist after them. A parent that
      // signals the moment readiness appears therefore always reaches a run
      // that can clean up after itself.
      expect(existsSync(join(fake.root, 'handlers-attached.txt'))).toBe(true)
      expect(existsSync(join(fake.root, 'fixture-ready.txt'))).toBe(true)
      expect(run.code).not.toBe(0)
      expect(printedReceipt(run)).toBeNull()
      expectOwnedInstanceRemoved(fake)
    })
  }, 40_000)

  test('a live focused journey is settled before the repository is removed', async () => {
    const result = await withFakeRepository({ journey: 'hangs' }, async (fake) => {
      const run = await runLane(fake.root, { killWhenReady: 'journey', signal: 'SIGKILL' })
      expect(run.signal).toBe('SIGKILL')
      expect(printedReceipt(run)).toBeNull()
      // The focused journey was live when the run was destroyed: it started,
      // and it had not finished, so the repository it writes into is still
      // here and the child is still running.
      expect(existsSync(join(fake.root, 'journey-ready.txt'))).toBe(true)
      expect(existsSync(join(fake.root, 'journey-finished.txt'))).toBe(false)
    })
    // The live child settled before the repository was removed.
    expect(result.settled).toBe(true)
  }, 40_000)

  test('a child that never settles fails the qualification and keeps the repository', async () => {
    // The fixture settled and the focused journey did not. The qualification
    // fails, and the repository it would have removed is preserved, rather
    // than being removed under a live child.
    let failure: unknown
    try {
      await withFakeRepository(
        { journey: 'hangs' },
        async (fake) => {
          const run = await runLane(fake.root, { killWhenReady: 'journey', signal: 'SIGKILL' })
          expect(run.signal).toBe('SIGKILL')
        },
        { settlementTimeoutMs: 200 }
      )
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toContain('did not settle')
    const preserved = /preserved at (.+)$/.exec(String(failure))?.[1]
    expect(preserved).toBeTruthy()
    expect(existsSync(preserved as string)).toBe(true)
    // The child that did not settle is still there, and the repository that
    // was preserved still holds it.
    expect(existsSync(join(preserved as string, 'fixture-finished.txt'))).toBe(true)
    expect(existsSync(join(preserved as string, 'journey-finished.txt'))).toBe(false)
    // The live child is given the time it needs before the preserved
    // repository is cleared by the qualification itself.
    await new Promise((settled) => setTimeout(settled, 3500))
    rmSync(preserved as string, { recursive: true, force: true })
  }, 40_000)

  test('the qualification removes its own temporary Docker', async () => {
    await withFakeRepository({}, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(0)
      // The Docker the qualification handed the run was its own temporary
      // resource, and it is gone with the run.
      expect(existsSync(run.shimDirectory)).toBe(false)
    })
  }, 30_000)

  test('the failure evidence carries no credential', async () => {
    await withFakeRepository({ fixture: 'fails', cleanup: 'throws' }, async (fake) => {
      const run = await runLane(fake.root)
      // The child printed the secret, and the lane did not relay it: the
      // evidence the run retained names the failure and nothing else.
      expect(readFileSync(join(fake.root, 'fixture-output.txt'), 'utf8')).toContain(password)
      expect(run.stderr).not.toContain(password)
      expect(run.stdout).not.toContain(password)
    })
  }, 30_000)

  test('the lane removes only the instance it created', async () => {
    await withFakeRepository({}, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(0)
      // The owned instance is the one the run created, and it is the only one
      // the run removed.
      expectOwnedInstanceRemoved(fake)
    })
  }, 30_000)

  test('a run that succeeds publishes the receipt with the lifecycle fields', async () => {
    await withFakeRepository({}, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(0)
      const receipt = printedReceipt(run)
      expect(receipt?.status).toBe('passed')
      // The lifecycle result fields are the acceptance lane's own. They
      // survive the run unchanged, and the pull-request gate carries them.
      const journey = receipt?.desktopPrincipal as Record<string, unknown>
      expect(journey.accounts).toBe(3)
      expect(journey.mappedUsers).toBe(3)
      expect(journey.exchanges).toBe(1)
      expect(journey.orphanUsers).toBe(0)
      expect(journey.provider).toBe('better-auth')
      expect(journey.refused).toEqual({ origin: 1, pkce: 1, replay: 1 })
      expect(run.stdout).not.toContain(password)
    })
  }, 30_000)
})

describe('the qualification is hermetic', () => {
  test('the run discovers Docker through the qualification’s own seam', async () => {
    await withFakeRepository({}, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(0)
      // The shim answers the lane's discovery, so the runner's own Docker was
      // never consulted, and the endpoint the lane used is the synthetic one.
      expect(existsSync(join(fake.root, 'docker-was-called.txt'))).toBe(true)
      expect(run.stderr).not.toContain('could not inspect the selected Docker context endpoint')
    })
  }, 30_000)

  test('a caller’s Docker settings are excluded from the run', async () => {
    const environment = laneEnvironment({
      DOCKER_TLS_VERIFY: '1',
      DOCKER_CERT_PATH: '/tmp/hostile.pem',
      DOCKER_CONTEXT: 'hostile',
    })
    // The lane refuses a TLS or a certificate override, so a caller that
    // carries one would stop the qualification. The environment the run gets
    // carries none of them.
    expect(environment.DOCKER_TLS_VERIFY).toBeUndefined()
    expect(environment.DOCKER_CERT_PATH).toBeUndefined()
    expect(environment.DOCKER_CONTEXT).toBeUndefined()
    expect(environment.DOCKER_HOST).toBe(syntheticDockerEndpoint)
  })

  test('a run with Docker unavailable fails closed', async () => {
    await withFakeRepository({}, async (fake) => {
      const run = await runLane(fake.root, { docker: 'unavailable' })
      // The lane cannot resolve an endpoint, so it proves nothing and
      // publishes no receipt.
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
      expect(run.stderr).toContain('could not inspect the selected Docker context endpoint')
      // The instance was never created, so there was nothing to remove.
      expect(ownedInstanceExists(fake)).toBe(false)
    })
  }, 30_000)

  test('a run with a hostile Docker setting fails closed', async () => {
    await withFakeRepository({}, async (fake) => {
      const run = await runLane(fake.root, {
        override: { DOCKER_CERT_PATH: '/tmp/hostile.pem' },
      })
      // The lane refuses a certificate override outright, so a caller that
      // carries one cannot make the run reach a database.
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stderr).toContain('refuses Docker TLS overrides')
      expect(ownedInstanceExists(fake)).toBe(false)
    })
  }, 30_000)
})

describe('the pull-request gate refuses every failed run', () => {
  test('a failed run is refused and publishes no artifact', async () => {
    await withFakeRepository({ fixture: 'fails' }, async (fake) => {
      const run = await runLane(fake.root)
      const artifactFile = join(fake.root, 'artifact.json')
      expect(() =>
        gateAcceptanceReceipt({
          output: run.stdout,
          expectedSha: fake.sha,
          artifactFile,
        })
      ).toThrow('printed no receipt')
      expect(existsSync(artifactFile)).toBe(false)
    })
  }, 30_000)

  test('a receipt from another tree is refused and publishes no artifact', async () => {
    await withFakeRepository({}, async (fake) => {
      const run = await runLane(fake.root)
      const artifactFile = join(fake.root, 'artifact.json')
      // The run happened in the fake tree, so its receipt does not name the
      // head the job checked out.
      expect(() =>
        gateAcceptanceReceipt({
          output: run.stdout,
          expectedSha: 'a'.repeat(40),
          artifactFile,
        })
      ).toThrow('does not name the exact head')
      expect(existsSync(artifactFile)).toBe(false)
    })
  }, 30_000)
})
