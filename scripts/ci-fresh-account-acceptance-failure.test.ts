import { describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
// failure and the cleanup failure both reported, the owned resource removed
// and nothing else, and evidence that carries no credential.

const lanePath = resolve(import.meta.dir, 'fresh-postgres-acceptance/run.mjs')
const password = 'fake-postgres-password'
const fakeUrl = `postgresql://postgres:${password}@127.0.0.1:5432/postgres?sslmode=disable`

/** How the fakes behave in one run of the lane. */
type Behaviour = {
  provisioning?: 'ok' | 'throws'
  fixture?: 'ok' | 'fails' | 'hangs'
  journey?: 'ok' | 'fails' | 'skips' | 'silent'
  cleanup?: 'ok' | 'throws'
}

const write = (root: string, path: string, content: string) => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
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

  // The provisioner. It owns one container and removes only that one.
  write(
    root,
    'scripts/capture-provisioning.mjs',
    `import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function startCaptureProvisioning(register) {
  const handle = {
    containerName: 'adea-capture-prov-fake',
    databaseUrl: ${JSON.stringify(fakeUrl)},
    stop() {
      writeFileSync(resolve(root, 'stopped.txt'), handle.containerName)
      ${behaviour.cleanup === 'throws' ? "throw new Error('the owned container could not be removed')" : ''}
    },
  }
  ${
    behaviour.provisioning === 'throws'
      ? "throw new Error('the disposable instance could not start')"
      : 'register(handle)\n  return handle'
  }
}
`
  )

  // The fixture: it applies the schema and prints the receipt the lane reads.
  const fixtureBody =
    behaviour.fixture === 'hangs'
      ? 'await new Promise((resolve) => setTimeout(resolve, 2000))'
      : behaviour.fixture === 'fails'
        ? `import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const line = 'the fixture failed with the secret ${password}\\n'
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
  write(root, 'scripts/fresh-postgres-acceptance/fixture.ts', `${fixtureBody}\n`)

  // The focused journey: it prints its own receipt, and the lane requires it.
  const journeyBody =
    behaviour.journey === 'skips'
      ? "test.skip('the journey did not run', () => {})"
      : behaviour.journey === 'fails'
        ? "test('the journey failed', () => { throw new Error('the journey failed') })"
        : behaviour.journey === 'silent'
          ? "test('the journey ran without a receipt', () => {})"
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
    `import { test } from 'bun:test'\n\n${journeyBody}\n`
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
}

/** Runs the lane against a fake repository and collects what it printed. */
async function runLane(
  root: string,
  options: { killAfterMs?: number; signal?: NodeJS.Signals } = {}
): Promise<LaneRun> {
  const child = spawn('node', [lanePath, '--repository', root], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_SECRET: password },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.on('error', (error) => rejectExit(error))
      child.on('exit', (code, signal) => resolveExit({ code, signal }))
    }
  )
  if (options.killAfterMs !== undefined) {
    setTimeout(() => child.kill(options.signal ?? 'SIGTERM'), options.killAfterMs)
  }
  const { code, signal } = await exited
  return { code, signal, stdout, stderr }
}

/** The receipt the lane printed, or null when it printed none. */
function printedReceipt(run: LaneRun): Record<string, unknown> | null {
  try {
    return parseAcceptanceReceipt(run.stdout)
  } catch {
    return null
  }
}

const withFakeRepository = async (
  behaviour: Behaviour,
  body: (fake: { root: string; sha: string }) => Promise<void>
) => {
  const fake = createFakeRepository(behaviour)
  try {
    await body(fake)
  } finally {
    rmSync(fake.root, { recursive: true, force: true })
  }
}

describe('the acceptance lane fails closed', () => {
  test('a setup failure publishes no receipt', async () => {
    await withFakeRepository({ provisioning: 'throws' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
      expect(run.stderr).toContain('the disposable instance could not start')
    })
  }, 30_000)

  test('a migration failure publishes no receipt', async () => {
    await withFakeRepository({ fixture: 'fails' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
      expect(run.stderr).toContain('fresh-schema fixture failed')
    })
  }, 30_000)

  test('a test failure publishes no receipt', async () => {
    await withFakeRepository({ journey: 'fails' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
      expect(run.stderr).toContain('the desktop principal acceptance phase failed')
    })
  }, 30_000)

  test('a skipped journey publishes no receipt', async () => {
    await withFakeRepository({ journey: 'skips' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stderr).toContain('skipped 1 test(s)')
    })
  }, 30_000)

  test('a journey that printed no receipt publishes no receipt', async () => {
    await withFakeRepository({ journey: 'silent' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stderr).toContain('produced no receipt')
    })
  }, 30_000)

  test('a cleanup failure publishes no receipt and is reported', async () => {
    await withFakeRepository({ cleanup: 'throws' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      expect(printedReceipt(run)).toBeNull()
      expect(run.stderr).toContain('owned PostgreSQL cleanup failed')
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
    })
  }, 30_000)

  test('a cancelled run publishes no receipt', async () => {
    await withFakeRepository({ fixture: 'hangs' }, async (fake) => {
      const run = await runLane(fake.root, { killAfterMs: 500, signal: 'SIGTERM' })
      expect(run.signal).toBe('SIGTERM')
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
    })
  }, 30_000)

  test('a run the job timeout killed publishes no receipt', async () => {
    await withFakeRepository({ fixture: 'hangs' }, async (fake) => {
      const run = await runLane(fake.root, { killAfterMs: 500, signal: 'SIGKILL' })
      expect(run.signal).toBe('SIGKILL')
      expect(printedReceipt(run)).toBeNull()
      expect(run.stdout).not.toContain('"status":"passed"')
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

  test('the lane removes only the container it created', async () => {
    await withFakeRepository({ cleanup: 'throws' }, async (fake) => {
      const run = await runLane(fake.root)
      expect(run.code).toBe(1)
      // The owned container is the one the run created, and it is the only
      // one the run tried to remove.
      expect(readFileSync(join(fake.root, 'stopped.txt'), 'utf8')).toBe('adea-capture-prov-fake')
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
