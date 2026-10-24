import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { spyOn, test } from 'bun:test'
import {
  captureCommand,
  composeImageVariable,
  composePostgresImage,
  defaultPullBackoffMs,
  ensureImage,
  fallbackImages,
  isRegistryRateLimit,
  processGroupHasLiveMember,
  runWithPullBackoff,
  runWithPullFallback,
  withComposeImage,
} from './docker-pull-backoff.mjs'

// Verbatim signature from the failed Host CI compose pull.
const rateLimited = { status: 1, stdout: '', stderr: 'postgres toomanyrequests: Rate exceeded' }
const succeeded = { status: 0, stdout: 'Container postgres Healthy', stderr: '' }
const permanent = { status: 1, stdout: '', stderr: 'manifest unknown' }
const ecrDataLimit = {
  status: 1,
  stdout: '',
  stderr: 'postgres Error toomanyrequests: Data limit exceeded',
}
const canonicalImage =
  'public.ecr.aws/docker/library/postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2'
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const integrationRunner = fileURLToPath(new URL('./test-integration.mjs', import.meta.url))
const e2eSetup = fileURLToPath(new URL('./e2e-setup.mjs', import.meta.url))
const testLocal = fileURLToPath(new URL('../apps/web/start/test-local.mjs', import.meta.url))
const disconnectFixture = fileURLToPath(
  new URL('../apps/web/start/test-stream-disconnect.mjs', import.meta.url)
)

type Result = {
  status: number | null
  stdout?: string
  stderr?: string
  error?: Error
  cancelled?: boolean
  timedOut?: boolean
  reaped?: boolean
}

// Each call returns the next scripted result; the last one repeats.
function scripted(results: Result[]) {
  const calls: number[] = []
  const attempt = () => {
    calls.push(calls.length)
    return results[Math.min(calls.length - 1, results.length - 1)]
  }
  return { attempt, calls }
}

function recordingSleep() {
  const delays: number[] = []
  return { delays, sleep: async (milliseconds: number) => void delays.push(milliseconds) }
}

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'adea-pull-backoff-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function waitForLog(path: string, expected: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, 'utf8')).includes(expected)) return
    } catch {
      /* The child has not created its log yet. */
    }
    await delay(10)
  }
  throw new Error(`Timed out waiting for ${expected} in ${path}`)
}

// A stand-in `docker` executable that runs `body` on every call.
async function writeDockerStub(dir: string, body: string) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'docker')
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

test('retries a transient 429 and returns the eventual success', async () => {
  const { attempt, calls } = scripted([rateLimited, succeeded])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, succeeded)
  assert.equal(calls.length, 2)
  assert.deepEqual(delays, [defaultPullBackoffMs[0]])
})

test('awaits an asynchronous attempt before judging its result', async () => {
  const { attempt, calls } = scripted([rateLimited, succeeded])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(async () => attempt(), { sleep, log: () => {} })
  assert.equal(result, succeeded)
  assert.equal(calls.length, 2)
  assert.deepEqual(delays, [defaultPullBackoffMs[0]])
})

test('returns a permanent error on the first attempt without delay', async () => {
  const { attempt, calls } = scripted([permanent])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, permanent)
  assert.equal(calls.length, 1)
  assert.deepEqual(delays, [])
})

test('bounds persistent 429s and surfaces the last rate-limit result', async () => {
  const { attempt, calls } = scripted([rateLimited])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, rateLimited)
  assert.equal(calls.length, defaultPullBackoffMs.length + 1)
  assert.deepEqual(delays, defaultPullBackoffMs)
})

test('recognizes only the registry rate-limit signature', () => {
  assert.equal(isRegistryRateLimit(rateLimited.stderr), true)
  assert.equal(isRegistryRateLimit('429 Too Many Requests'), true)
  assert.equal(isRegistryRateLimit('manifest unknown'), false)
  assert.equal(isRegistryRateLimit(''), false)
})

test('captures a real child output and exit status', async () => {
  const result = await captureCommand(process.execPath, [
    '-e',
    "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
  ])
  assert.equal(result.status, 3)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
  assert.equal(result.error, undefined)
})

test('reports a spawn failure as a result instead of rejecting', async () => {
  const result = await captureCommand('/nonexistent/adea-docker-missing', [])
  assert.equal(result.error?.code, 'ENOENT')
  assert.notEqual(result.status, 0)
})

test('interrupting delayed Compose provisioning reaps it before teardown and prevents fallback', async () => {
  await withTempDir(async (dir) => {
    const events = join(dir, 'events')
    const env = { ...process.env, EVENTS: events }
    const controller = new AbortController()
    const script = `
      const fs = require('node:fs')
      const [command, ...args] = process.argv.slice(1)
      const log = (event) => fs.appendFileSync(process.env.EVENTS, event + '\\n')
      if (command === 'compose' && args.includes('up')) {
        log('up:start')
        process.stderr.write('postgres toomanyrequests: Rate exceeded')
        const finish = setTimeout(() => { log('up:complete'); process.exit(1) }, 10_000)
        process.on('SIGTERM', () => { clearTimeout(finish); log('up:cancel'); process.exit(1) })
        log('up:ready')
      } else if (command === 'compose' && args.includes('down')) {
        log('down:start')
        process.exit(0)
      } else {
        log('unexpected-command:' + command)
        process.exit(1)
      }
    `
    const lines: string[] = []
    let pullCalls = 0
    let provision: Awaited<ReturnType<typeof captureCommand>> | undefined
    const operation = runWithPullFallback(
      async () => {
        provision = await captureCommand(
          process.execPath,
          ['-e', script, 'compose', '-p', 'fixture', 'up'],
          {
            env,
            signal: controller.signal,
            terminationGraceMs: 100,
            reapTimeoutMs: 1_000,
            processGroup: true,
          }
        )
        return provision
      },
      canonicalImage,
      {
        signal: controller.signal,
        pull: async () => {
          pullCalls += 1
          return succeeded
        },
        log: () => {},
      }
    )
    try {
      await waitForLog(events, 'up:ready')
      controller.abort(new Error('fixture interrupted during provisioning'))
      await assert.rejects(operation, /fixture interrupted during provisioning/)
      assert.equal(provision?.cancelled, true)
      assert.equal(provision?.reaped, true)
      assert.equal(provision?.groupExited, true)
      assert.equal(pullCalls, 0, 'Cancellation must prevent image fallback and retry commands')

      const down = await captureCommand(
        process.execPath,
        ['-e', script, 'compose', '-p', 'fixture', 'down'],
        {
          env,
          timeoutMs: 1_000,
        }
      )
      assert.equal(down.status, 0)
      lines.push(...(await readFile(events, 'utf8')).trim().split('\n'))
      assert.deepEqual(lines, ['up:start', 'up:ready', 'up:cancel', 'down:start'])
    } finally {
      if (!controller.signal.aborted) controller.abort()
      await operation.catch(() => {})
    }
  })
})

test.skipIf(process.platform === 'win32')(
  'a hung Compose down kills and reaps its owned process group',
  async () => {
    await withTempDir(async (dir) => {
      const parentPidFile = join(dir, 'hung-down-parent.pid')
      const descendantPidFile = join(dir, 'hung-down-descendant.pid')
      const lateSideEffect = join(dir, 'hung-down-late-side-effect')
      const descendantScript = `
      const fs = require('node:fs')
      fs.writeFileSync(process.env.DESCENDANT_PID_FILE, String(process.pid))
      process.on('SIGTERM', () => {})
      setTimeout(() => fs.writeFileSync(process.env.LATE_SIDE_EFFECT, 'late'), 4_000)
      setInterval(() => {}, 1_000)
    `
      const parentScript = `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      spawn(process.execPath, ['-e', process.env.DESCENDANT_SCRIPT], { stdio: 'inherit' })
      fs.writeFileSync(process.env.PARENT_PID_FILE, String(process.pid))
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1_000)
    `
      const env = {
        ...process.env,
        PARENT_PID_FILE: parentPidFile,
        DESCENDANT_PID_FILE: descendantPidFile,
        LATE_SIDE_EFFECT: lateSideEffect,
        DESCENDANT_SCRIPT: descendantScript,
      }
      const startedAt = Date.now()
      const result = await captureCommand(
        process.execPath,
        ['-e', parentScript, 'compose', '-p', 'fixture', 'down'],
        {
          env,
          timeoutMs: 2_500,
          terminationGraceMs: 100,
          reapTimeoutMs: 1_500,
          processGroup: true,
        }
      )
      assert.equal(result.timedOut, true)
      assert.equal(result.reaped, true)
      assert.equal(result.groupExited, true, 'The Docker CLI and plugin stub group must be gone')
      assert.equal(result.status, null)
      assert.equal(result.signal, 'SIGKILL')
      assert.match(result.error?.message ?? '', /timed out/)
      assert.ok(Number(await readFile(parentPidFile, 'utf8')) > 0)
      assert.ok(Number(await readFile(descendantPidFile, 'utf8')) > 0)
      await delay(1_700)
      await assert.rejects(readFile(lateSideEffect), { code: 'ENOENT' })
      assert.ok(
        Date.now() - startedAt < 6_000,
        'Teardown and side-effect check must remain bounded'
      )
    })
  },
  8_000
)

// A fake `/proc`: one `<pid>/stat` per process, in the kernel's layout, so the zombie decision is
// exercised without needing a process that init has not collected.
async function fakeProc(
  dir: string,
  processes: Array<{
    pid: number
    comm?: string
    state: string
    ppid?: number
    pgrp: number
    threads?: number
  }>
) {
  for (const { pid, comm = 'node', state, ppid = 1, pgrp, threads = 1 } of processes) {
    await mkdir(join(dir, String(pid)), { recursive: true })
    await writeFile(
      join(dir, String(pid), 'stat'),
      `${pid} (${comm}) ${state} ${ppid} ${pgrp} ${pgrp} 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 ${threads} 0 5 1000 100`
    )
  }
}

test('a process group that holds only zombies has no live member', async () => {
  await withTempDir(async (dir) => {
    await fakeProc(dir, [
      { pid: 4100, state: 'Z', pgrp: 4100 },
      { pid: 4101, state: 'Z', pgrp: 4100 },
      { pid: 4200, state: 'S', pgrp: 4200 },
    ])
    assert.equal(processGroupHasLiveMember(4100, dir), false)
  })
})

test('a process group with a running, sleeping or stopped member is still live', async () => {
  for (const state of ['R', 'S', 'D', 'T', 't']) {
    await withTempDir(async (dir) => {
      await fakeProc(dir, [
        { pid: 4100, state: 'Z', pgrp: 4100 },
        { pid: 4101, state, pgrp: 4100 },
      ])
      assert.equal(processGroupHasLiveMember(4100, dir), true, `state ${state}`)
    })
  }
})

test('the group check reads the process group, not the parent, and survives a hostile command name', async () => {
  await withTempDir(async (dir) => {
    await fakeProc(dir, [
      // Live, parented to the group leader but in another group: not a member.
      { pid: 4300, state: 'S', ppid: 4100, pgrp: 4300 },
      // A zombie whose command name contains spaces and parentheses, as a process can set.
      { pid: 4101, state: 'Z', comm: 'a) S 1 4300 (b', pgrp: 4100 },
    ])
    assert.equal(processGroupHasLiveMember(4100, dir), false)
    assert.equal(processGroupHasLiveMember(4300, dir), true)
  })
})

test('an exited leader whose other threads run is a live group, not a zombie one', async () => {
  await withTempDir(async (dir) => {
    // pthread_exit in the leader: /proc shows it as Z with the thread count still above one.
    await fakeProc(dir, [{ pid: 4100, state: 'Z', pgrp: 4100, threads: 2 }])
    assert.equal(processGroupHasLiveMember(4100, dir), true)
    // The same leader after its last thread is gone is a lone zombie.
    await fakeProc(dir, [{ pid: 4100, state: 'Z', pgrp: 4100, threads: 1 }])
    assert.equal(processGroupHasLiveMember(4100, dir), false)
    await fakeProc(dir, [{ pid: 4100, state: 'X', pgrp: 4100, threads: 3 }])
    assert.equal(processGroupHasLiveMember(4100, dir), true)
  })
})

test('a record that cannot be read in full never excludes a process from the group check', async () => {
  const stats = [
    '4100 (node) S 1 nope',
    '4100 (node) Z 1 4100',
    '4100 (node) Z 1 4100 4100 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 two 0 5 1000 100',
    '4100 (node) Z 1 4100 4100 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 -1 0 5 1000 100',
    '4100 (node) Z 1 4100 4100 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1.5 0 5 1000 100',
    '4100 (node) 1 1 4100 4100 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 5 1000 100',
    '4100 (node) Z one 4100 4100 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 5 1000 100',
    // A malformed record of a process in another group is unknown too, not skippable.
    '4200 (node) S 1 nope',
  ]
  for (const stat of stats)
    await withTempDir(async (dir) => {
      await mkdir(join(dir, '4200'), { recursive: true })
      await writeFile(join(dir, '4200', 'stat'), stat)
      await fakeProc(dir, [{ pid: 4100, state: 'Z', pgrp: 4100 }])
      await writeFile(
        join(dir, '4100', 'stat'),
        stat.startsWith('4100')
          ? stat
          : '4100 (node) Z 1 4100 4100 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 5 1000 100'
      )
      assert.equal(processGroupHasLiveMember(4100, dir), true, stat)
    })
})

// The real kernel record for the leader-exited case: a Python process starts a worker thread and
// then ends only its own thread with pthread_exit, which leaves a zombie leader and a live worker.
// The fixture owns the process it starts: its lifecycle is observed from the moment it is spawned,
// only a child that is still live is signalled, and teardown is not finished until the child has
// been seen to exit and its group is gone. A teardown that cannot be verified fails the test.
test.skipIf(process.platform !== 'linux' || spawnSync('python3', ['-V']).status !== 0)(
  'a real exited leader with a live worker thread keeps its group live',
  async () => {
    const script = `
import ctypes, threading, time
def worker():
    while True:
        time.sleep(0.05)
threading.Thread(target=worker, daemon=True).start()
ctypes.CDLL(None).pthread_exit(None)
`
    const child = spawn('python3', ['-c', script], { detached: true, stdio: 'ignore' })
    let spawnError: Error | undefined
    let exited = false
    const hasExited = () => exited
    const exit = new Promise<void>((resolve) => {
      child.once('exit', () => {
        exited = true
        resolve()
      })
      child.once('error', (error) => {
        spawnError = error
        resolve()
      })
    })
    let primary: unknown
    try {
      await Promise.race([delay(50), exit])
      assert.equal(spawnError, undefined, `The fixture failed to start: ${spawnError?.message}`)
      const pid = child.pid
      assert.ok(pid !== undefined && pid > 0, 'The fixture must have a process id')
      let state = ''
      let threads = ''
      for (let attempt = 0; attempt < 60 && !hasExited(); attempt += 1) {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
          const fields = stat
            .slice(stat.lastIndexOf(')') + 1)
            .trim()
            .split(/\s+/)
          ;[state, threads] = [fields[0]!, fields[17]!]
          if (state === 'Z' && Number(threads) > 1) break
        } catch {}
        await delay(50)
      }
      assert.equal(exited, false, 'The fixture must still be running')
      assert.equal(state, 'Z', 'The fixture leader must have exited as a zombie')
      assert.ok(Number(threads) > 1, 'The fixture must still hold a live worker thread')
      assert.doesNotThrow(() => process.kill(-pid, 0))
      assert.equal(processGroupHasLiveMember(pid), true)
    } catch (error) {
      primary = error
    }
    let teardownError: unknown
    try {
      const pid = child.pid
      // Signal only a child this test still owns and has not seen exit.
      if (pid !== undefined && !exited && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') throw killError
        }
      }
      if (pid !== undefined) {
        await Promise.race([exit, delay(3_000)])
        assert.ok(
          exited || spawnError !== undefined,
          'The fixture did not exit within 3 s of SIGKILL'
        )
        assert.throws(
          () => process.kill(-pid, 0),
          { code: 'ESRCH' },
          'The fixture group must be gone'
        )
      }
    } catch (error) {
      teardownError = error
    }
    if (teardownError !== undefined)
      throw primary === undefined
        ? teardownError
        : new AggregateError(
            [primary, teardownError],
            'The assertion and the fixture teardown both failed'
          )
    if (primary !== undefined) throw primary
  },
  10_000
)

test('a record without a real pid and parenthesised command envelope is never trusted', async () => {
  const tail = '4100 4100 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 5 1000 100'
  const stats: Array<[string, string]> = [
    ['no parentheses at all', `4100 node Z 1 ${tail}`],
    ['a multiword command without parentheses', `4100 my node app Z 1 ${tail}`],
    ['only a closing parenthesis', `4100 node) Z 1 ${tail}`],
    ['no space after the envelope', `4100 (node)Z 1 ${tail}`],
    ['a non-numeric pid', `abc (node) Z 1 ${tail}`],
    ['a pid that is not this entry', `4999 (node) Z 1 ${tail}`],
    ['text before the pid', `x 4100 (node) Z 1 ${tail}`],
    ['an empty record', ''],
  ]
  for (const [label, stat] of stats)
    await withTempDir(async (dir) => {
      await mkdir(join(dir, '4100'), { recursive: true })
      await writeFile(join(dir, '4100', 'stat'), stat)
      assert.equal(processGroupHasLiveMember(4100, dir), true, label)
    })
})

test('an unreadable or malformed process table is reported as live, never as gone', async () => {
  await withTempDir(async (dir) => {
    assert.equal(processGroupHasLiveMember(4100, join(dir, 'missing')), true)
    await mkdir(join(dir, '4100'), { recursive: true })
    await writeFile(join(dir, '4100', 'stat'), 'garbage')
    assert.equal(processGroupHasLiveMember(4100, dir), true)
  })
})

test('native disconnect fixture reaps interrupted commands before bounded Compose teardown', async () => {
  const source = await readFile(disconnectFixture, 'utf8')
  assert.match(source, /new AbortController\(\)/)
  assert.match(source, /await Promise\.allSettled\(inFlightCommands\)/)
  assert.match(source, /signal: interruptionController\.signal/)
  assert.match(source, /processGroup = true/)
  assert.match(source, /!result\.value\.groupExited/)
  assert.match(source, /timeoutMs: composeDownTimeoutMs/)
})

test('retries a real rate-limited child to eventual success', async () => {
  await withTempDir(async (dir) => {
    // First run prints the registry rejection; later runs succeed.
    const flag = join(dir, 'pulled')
    const script =
      "const fs = require('node:fs'); if (fs.existsSync(process.env.FLAG)) process.exit(0); " +
      "fs.writeFileSync(process.env.FLAG, ''); " +
      "console.error('postgres toomanyrequests: Rate exceeded'); process.exit(1)"
    const { delays, sleep } = recordingSleep()
    const result = await runWithPullBackoff(
      () =>
        captureCommand(process.execPath, ['-e', script], {
          env: { ...process.env, FLAG: flag },
        }),
      { sleep, log: () => {} }
    )
    assert.equal(result.status, 0)
    assert.deepEqual(delays, [defaultPullBackoffMs[0]])
  })
})

test('returns a real permanent child failure without retrying', async () => {
  await withTempDir(async (dir) => {
    const calls = join(dir, 'calls')
    const script =
      "require('node:fs').appendFileSync(process.env.CALLS, 'x'); " +
      "console.error('manifest unknown'); process.exit(1)"
    const { delays, sleep } = recordingSleep()
    const result = await runWithPullBackoff(
      () =>
        captureCommand(process.execPath, ['-e', script], {
          env: { ...process.env, CALLS: calls },
        }),
      { sleep, log: () => {} }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /manifest unknown/)
    assert.equal(await readFile(calls, 'utf8'), 'x')
    assert.deepEqual(delays, [])
  })
})

test('every Postgres entrypoint starts the database through the pull-fallback helper', async () => {
  for (const path of [testLocal, e2eSetup, integrationRunner]) {
    const source = await readFile(path, 'utf8')
    assert.match(
      source,
      /import \{[^}]*\brunWithPullFallback\b[^}]*\} from '[\w./-]*docker-pull-backoff\.mjs'/,
      path
    )
    assert.match(source, /await runWithPullFallback\(/, path)
    assert.match(source, /await composeUpPostgres\(\)/, path)
    // A bare `up` through run() would bypass the fallback and the backoff.
    assert.doesNotMatch(source, /run\(\s*'docker',\s*\[[^\]]*'up'/, path)
  }
})

test('compose.yml takes the Postgres image from the override with a digest-pinned default', async () => {
  const image = composePostgresImage(repositoryRoot)
  assert.match(image, /^public\.ecr\.aws\/docker\/library\/postgres:[\w.-]+@sha256:[0-9a-f]{64}$/)
  const compose = await readFile(join(repositoryRoot, 'compose.yml'), 'utf8')
  assert.ok(compose.includes(`\${${composeImageVariable}:-${image}}`))
})

test('derives the same digest on the fallback registries and none for other images', () => {
  assert.deepEqual(fallbackImages(canonicalImage), [
    'mirror.gcr.io/library/postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2',
    'docker.io/library/postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2',
  ])
  assert.deepEqual(fallbackImages('mcr.microsoft.com/playwright:v1.63.0-noble'), [])
})

test('selects a fallback image only when one is given', () => {
  const env = { PATH: '/bin' }
  assert.equal(withComposeImage(env, undefined), env)
  assert.deepEqual(withComposeImage(env, 'mirror.gcr.io/library/postgres:18-alpine'), {
    PATH: '/bin',
    [composeImageVariable]: 'mirror.gcr.io/library/postgres:18-alpine',
  })
})

function fallbackHarness(attempts: Record<string, Result[]>, pulls: Record<string, Result> = {}) {
  const attempted: (string | undefined)[] = []
  const pulled: string[] = []
  const messages: string[] = []
  const { delays, sleep } = recordingSleep()
  const counts: Record<string, number> = {}
  return {
    attempted,
    pulled,
    messages,
    delays,
    run: () =>
      runWithPullFallback(
        (image) => {
          attempted.push(image)
          const key = image ?? 'canonical'
          const results = attempts[key] ?? [ecrDataLimit]
          counts[key] = (counts[key] ?? 0) + 1
          return results[Math.min(counts[key] - 1, results.length - 1)]
        },
        canonicalImage,
        {
          sleep,
          log: (message: string) => messages.push(message),
          pull: async (reference: string) => {
            pulled.push(reference)
            return pulls[reference] ?? { status: 0, stdout: '', stderr: '' }
          },
        }
      ),
  }
}

const mirror = fallbackImages(canonicalImage)[0]!
const hub = fallbackImages(canonicalImage)[1]!

test('does not touch another registry when the canonical pull succeeds', async () => {
  const harness = fallbackHarness({ canonical: [succeeded] })
  assert.equal(await harness.run(), succeeded)
  assert.deepEqual(harness.attempted, [undefined])
  assert.deepEqual(harness.pulled, [])
})

test('returns a permanent canonical failure without trying a fallback', async () => {
  const harness = fallbackHarness({ canonical: [permanent] })
  assert.equal(await harness.run(), permanent)
  assert.deepEqual(harness.pulled, [])
  assert.deepEqual(harness.delays, [])
})

test('falls over to the mirror registry on a rate limit, without backing off', async () => {
  const harness = fallbackHarness({ canonical: [ecrDataLimit], [mirror]: [succeeded] })
  assert.equal(await harness.run(), succeeded)
  assert.deepEqual(harness.attempted, [undefined, mirror])
  assert.deepEqual(harness.pulled, [mirror])
  assert.deepEqual(harness.delays, [])
})

test('skips a fallback that cannot be pulled and tries the next one', async () => {
  const harness = fallbackHarness(
    { canonical: [ecrDataLimit], [hub]: [succeeded] },
    { [mirror]: { status: 1, stdout: '', stderr: 'manifest unknown' } }
  )
  assert.equal(await harness.run(), succeeded)
  assert.deepEqual(harness.attempted, [undefined, hub])
  assert.deepEqual(harness.pulled, [mirror, hub])
  assert.ok(harness.messages.some((message) => /manifest unknown/.test(message)))
})

test('moves on to Docker Hub when the mirror pulls but its run fails', async () => {
  const harness = fallbackHarness({
    canonical: [ecrDataLimit],
    [mirror]: [permanent],
    [hub]: [succeeded],
  })
  assert.equal(await harness.run(), succeeded)
  assert.deepEqual(harness.attempted, [undefined, mirror, hub])
  assert.deepEqual(harness.pulled, [mirror, hub])
  assert.deepEqual(harness.delays, [])
})

test('surfaces the last failure once every registry has failed in the ordinary way', async () => {
  const harness = fallbackHarness({
    canonical: [ecrDataLimit],
    [mirror]: [permanent],
    [hub]: [permanent],
  })
  assert.equal(await harness.run(), permanent)
  assert.deepEqual(harness.pulled.slice(0, 2), [mirror, hub])
})

test('backs off and retries every registry when all of them are rate limited', async () => {
  const harness = fallbackHarness({ canonical: [ecrDataLimit, ecrDataLimit, succeeded] })
  assert.equal(await harness.run(), succeeded)
  assert.deepEqual(harness.attempted, [undefined, mirror, hub, undefined, mirror, hub, undefined])
  assert.deepEqual(harness.delays, defaultPullBackoffMs.slice(0, 2))
})

test('bounds persistent rate limits across every registry', async () => {
  const harness = fallbackHarness({})
  assert.equal(await harness.run(), ecrDataLimit)
  assert.equal(harness.attempted.length, 3 * (defaultPullBackoffMs.length + 1))
  assert.deepEqual(harness.delays, defaultPullBackoffMs)
})

test('ensures an image without pulling when it is already local', async () => {
  const pulled: string[] = []
  const found = await ensureImage(canonicalImage, {
    inspect: async () => ({ status: 0 }),
    pull: async (reference: string) => (pulled.push(reference), succeeded),
    log: () => {},
  })
  assert.equal(found.image, canonicalImage)
  assert.equal(found.result.status, 0)
  assert.deepEqual(pulled, [])
})

test('ensures an image from a fallback registry and reports the reference now local', async () => {
  const pulled: string[] = []
  const { sleep } = recordingSleep()
  const found = await ensureImage(canonicalImage, {
    inspect: async () => ({ status: 1 }),
    pull: async (reference: string) => {
      pulled.push(reference)
      return reference === canonicalImage ? ecrDataLimit : succeeded
    },
    sleep,
    log: () => {},
  })
  assert.equal(found.result.status, 0)
  assert.equal(found.image, mirror)
  assert.deepEqual(pulled, [canonicalImage, mirror])
})

test('ECR rate limit, then an ordinary mirror failure, still reaches Docker Hub', async () => {
  const pulled: string[] = []
  const { delays, sleep } = recordingSleep()
  const found = await ensureImage(canonicalImage, {
    inspect: async () => ({ status: 1 }),
    pull: async (reference: string) => {
      pulled.push(reference)
      if (reference === canonicalImage) return ecrDataLimit
      if (reference === mirror) return { status: 1, stdout: '', stderr: 'manifest unknown' }
      return succeeded
    },
    sleep,
    log: () => {},
  })
  assert.equal(found.result.status, 0)
  assert.equal(found.image, hub)
  // Each registry once, in order, with no backoff before the last one is tried.
  assert.deepEqual(pulled, [canonicalImage, mirror, hub])
  assert.deepEqual(delays, [])
})

test('reports an image that no registry could provide', async () => {
  const { sleep } = recordingSleep()
  const found = await ensureImage(canonicalImage, {
    inspect: async () => ({ status: 1 }),
    pull: async () => ecrDataLimit,
    sleep,
    log: () => {},
  })
  assert.notEqual(found.result.status, 0)
})

test('e2e setup surfaces a permanent docker failure once, with its output', async () => {
  await withTempDir(async (dir) => {
    const bin = join(dir, 'bin')
    const calls = join(dir, 'calls')
    await writeDockerStub(
      bin,
      'echo call >> "$CALLS"\necho "Error response from daemon: manifest unknown" >&2\nexit 1'
    )
    const result = spawnSync(process.execPath, [e2eSetup], {
      encoding: 'utf8',
      env: { PATH: bin, CALLS: calls },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Error response from daemon: manifest unknown/)
    assert.match(
      result.stderr,
      /docker compose up -d --wait --wait-timeout 60 postgres failed with exit code 1/
    )
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1)
  })
})

test('e2e setup surfaces a missing docker executable as a spawn error', async () => {
  await withTempDir(async (dir) => {
    const empty = join(dir, 'empty')
    await mkdir(empty)
    const result = spawnSync(process.execPath, [e2eSetup], {
      encoding: 'utf8',
      env: { PATH: empty },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /ENOENT/)
  })
})

async function withDefaultDocker(
  mode: 'local' | 'fallback' | 'limited',
  run: (readCalls: () => Promise<string[]>, messages: string[]) => Promise<void>
) {
  await withTempDir(async (directory) => {
    const bin = join(directory, 'bin')
    const callsPath = join(directory, 'calls')
    await writeFile(callsPath, '')
    await writeDockerStub(
      bin,
      [
        'printf \'%s\\n\' "$*" >> "$DOCKER_CALLS"',
        'if [ "$1" = image ]; then [ "$DOCKER_MODE" = local ]; exit $?; fi',
        'if [ "$1" != pull ] || [ "$2" != --quiet ]; then exit 99; fi',
        `if [ "$DOCKER_MODE" = limited ] || [ "$3" = '${canonicalImage}' ]; then`,
        "  printf '%s\\n' 'toomanyrequests: Rate exceeded' >&2; exit 1",
        'fi',
        'exit 0',
      ].join('\n')
    )
    const previous = process.env
    const messages: string[] = []
    const warning = spyOn(console, 'warn').mockImplementation(
      (message) => void messages.push(String(message))
    )
    try {
      // The default command callbacks can only find this stub; neither a real
      // Docker daemon nor a registry is contacted, even on the failure path.
      process.env = { PATH: bin, DOCKER_CALLS: callsPath, DOCKER_MODE: mode }
      await run(
        async () => (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean),
        messages
      )
    } finally {
      process.env = previous
      warning.mockRestore()
    }
  })
}

test('default backoff uses its timer and warning without hiding the eventual result', async () => {
  const messages: string[] = []
  const warning = spyOn(console, 'warn').mockImplementation(
    (message) => void messages.push(String(message))
  )
  try {
    const { attempt, calls } = scripted([rateLimited, succeeded])
    assert.equal(await runWithPullBackoff(attempt, { delaysMs: [0] }), succeeded)
    assert.equal(calls.length, 2)
    assert.deepEqual(messages, [
      'Container registry rate-limited an image pull; retry 1 of 1 in 0s.',
    ])
  } finally {
    warning.mockRestore()
  }
})

test('default image inspection returns a local image without pulling', async () => {
  await withDefaultDocker('local', async (readCalls) => {
    const found = await ensureImage(canonicalImage)
    assert.equal(found.image, canonicalImage)
    assert.deepEqual(found.result, { status: 0, stdout: '', stderr: '' })
    assert.deepEqual(await readCalls(), [`image inspect ${canonicalImage}`])
  })
})

test('default inspect and pull callbacks preserve the pinned image through fallback', async () => {
  await withDefaultDocker('fallback', async (readCalls, messages) => {
    const found = await ensureImage(canonicalImage)
    assert.equal(found.image, mirror)
    assert.equal(found.result.status, 0)
    assert.ok(messages.some((message) => message.includes('toomanyrequests')))
    assert.ok(messages.some((message) => message.includes(`trying ${mirror}`)))
    assert.deepEqual(await readCalls(), [
      `image inspect ${canonicalImage}`,
      `pull --quiet ${canonicalImage}`,
      `pull --quiet ${mirror}`,
    ])
  })
})

test('default fallback pulls a mirror before running with it', async () => {
  await withDefaultDocker('fallback', async (readCalls) => {
    const attempted: (string | undefined)[] = []
    const result = await runWithPullFallback((image) => {
      attempted.push(image)
      return image === undefined ? rateLimited : succeeded
    }, canonicalImage)
    assert.equal(result, succeeded)
    assert.deepEqual(attempted, [undefined, mirror])
    assert.deepEqual(await readCalls(), [`pull --quiet ${mirror}`])
  })
})

test('default fallback timer and diagnostics stay bounded when every stub registry is limited', async () => {
  await withDefaultDocker('limited', async (readCalls, messages) => {
    let attempts = 0
    const result = await runWithPullFallback(
      () => {
        attempts += 1
        return rateLimited
      },
      canonicalImage,
      { delaysMs: [0] }
    )
    assert.equal(result, rateLimited)
    assert.equal(attempts, 2)
    assert.deepEqual(
      await readCalls(),
      [mirror, hub, mirror, hub].map((image) => `pull --quiet ${image}`)
    )
    assert.equal(messages.filter((message) => message.includes('trying ')).length, 4)
    assert.equal(messages.filter((message) => message.includes('retry 1 of 1 in 0s')).length, 1)
    assert.equal(
      messages.filter((message) => message.includes('failed: toomanyrequests')).length,
      4
    )
  })
})

test('rejects a compose image without the required explicit fallback variable', async () => {
  await withTempDir(async (directory) => {
    await writeFile(
      join(directory, 'compose.yml'),
      'services:\n  postgres:\n    image: postgres:18-alpine\n'
    )
    assert.throws(() => composePostgresImage(directory), /must define the postgres image as/)
  })
})
