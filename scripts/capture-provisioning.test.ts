// Subprocess and signal tests for the capture provisioning helper. Docker is replaced by a shim on PATH
// that records every call and answers the subcommands the helper uses, so these tests need no daemon and
// never touch a real container. The real-Docker path is covered by scripts/smoke/capture-provisioning.smoke.test.ts.

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
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
import { join, resolve } from 'node:path'

import {
  dockerCaptureRun,
  dockerDaemonAvailable,
  startCaptureProvisioning,
} from './capture-provisioning.mjs'

const helper = resolve(import.meta.dir, 'capture-provisioning.mjs')

// Records every call to its log, answers the helper's subcommands, and honours SHIM_RM for removal.
// The hang mode replaces the shell with sleep, so a killed removal leaves no process behind.
// The state file names the container the shim started, so an inspect of any other container answers the way
// Docker answers it, and SHIM_MOUNTS and SHIM_ANONYMOUS model the volumes Docker attaches to it.
const dockerShim = `#!/bin/sh
echo "$*" >> "$SHIM_LOG"
case "$1" in
  info) exit 0 ;;
  run)
    # SHIM_RUN throttles the image pull the way a shared-runner registry does: "ecr" only on the
    # canonical ECR Public reference, "all" on every registry, "fail" with an unrelated error.
    for last; do :; done
    case "$SHIM_RUN" in
      ecr) case "$last" in public.ecr.aws/*) echo "docker: Error response from daemon: toomanyrequests: Data limit exceeded" >&2; exit 125 ;; esac ;;
      all) echo "docker: Error response from daemon: toomanyrequests: Data limit exceeded" >&2; exit 125 ;;
      fail) echo "docker: Error response from daemon: manifest unknown" >&2; exit 125 ;;
      slow) sleep 5; echo "docker: Error response from daemon: toomanyrequests: Data limit exceeded" >&2; exit 125 ;;
      mirror-fails)
        case "$last" in
          public.ecr.aws/*) echo "docker: Error response from daemon: toomanyrequests: Data limit exceeded" >&2; exit 125 ;;
          mirror.gcr.io/*) echo "docker: Error response from daemon: manifest unknown" >&2; exit 125 ;;
        esac ;;
    esac
    # The container exists from here on. Its name is recorded, so only that container can be inspected.
    name=""
    previous=""
    for argument in "$@"; do
      if [ "$previous" = "--name" ]; then name="$argument"; fi
      previous="$argument"
    done
    if [ -n "$SHIM_STATE" ]; then printf '%s' "$name" > "$SHIM_STATE"; fi
    # SHIM_INSPECT=error removes the client itself, so every later call fails the way a
    # client that cannot be run at all fails.
    if [ "$SHIM_INSPECT" = "error" ]; then rm -f "$0"; fi
    exit 0 ;;
  port) echo "127.0.0.1:54329"; exit 0 ;;
  exec) exit 0 ;;
  inspect)
    for last; do :; done
    if [ -z "$SHIM_STATE" ] || [ ! -f "$SHIM_STATE" ] || [ "$(cat "$SHIM_STATE")" != "$last" ]; then
      echo "Error response from daemon: No such object: $last" >&2
      exit 1
    fi
    case "$SHIM_INSPECT" in
      status) echo "permission denied" >&2; exit 1 ;;
      hang) exec sleep 600 ;;
      malformed) printf '%s\n' 'not json'; exit 0 ;;
    esac
    printf '%s\n' "\${SHIM_MOUNTS:-[]}"
    exit 0 ;;
  volume)
    case "$2" in
      inspect)
        # A volume named in SHIM_ANONYMOUS carries Docker's own anonymous marker; any other one does not.
        for last; do :; done
        case "$SHIM_VOLUME_INSPECT" in
          status) echo "permission denied" >&2; exit 1 ;;
          hang) exec sleep 600 ;;
          malformed) printf '%s\n' 'not json'; exit 0 ;;
          status-once)
            count=0
            if [ -n "$SHIM_VOLUME_INSPECT_COUNTER" ] && [ -f "$SHIM_VOLUME_INSPECT_COUNTER" ]; then count=$(cat "$SHIM_VOLUME_INSPECT_COUNTER"); fi
            count=$((count + 1))
            if [ -n "$SHIM_VOLUME_INSPECT_COUNTER" ]; then printf '%s' "$count" > "$SHIM_VOLUME_INSPECT_COUNTER"; fi
            if [ "$count" -le 1 ]; then echo "permission denied" >&2; exit 1; fi
            ;;
        esac
        case ",$SHIM_ANONYMOUS," in
          *",$last,"*) printf '%s\n' '{"com.docker.volume.anonymous":""}' ;;
          *) printf '%s\n' '{}' ;;
        esac
        exit 0 ;;
      rm)
        # The removals are counted, so a failure can be limited to the first attempt.
        count=0
        if [ -n "$SHIM_COUNTER" ] && [ -f "$SHIM_COUNTER" ]; then count=$(cat "$SHIM_COUNTER"); fi
        count=$((count + 1))
        if [ -n "$SHIM_COUNTER" ]; then printf '%s' "$count" > "$SHIM_COUNTER"; fi
        if [ "$SHIM_VOLUME_RM" = "fail-once" ] && [ "$count" -le 1 ]; then
          echo "Error response from daemon: volume is in use - [volume $3]" >&2
          exit 1
        fi
        if [ "$SHIM_VOLUME_RM" = "fail" ] || [ "$SHIM_VOLUME_RM" = "in-use" ]; then
          echo "Error response from daemon: volume is in use - [volume $3]" >&2
          exit 1
        fi
        exit 0 ;;
      *) exit 1 ;;
    esac ;;
  rm)
    if [ "$SHIM_RM" = "missing" ]; then echo "Error response from daemon: No such container: $3" >&2; exit 1; fi
    if [ "$SHIM_RM" = "fail" ]; then echo "permission denied" >&2; exit 1; fi
    if [ "$SHIM_RM" = "fail-once" ]; then
      # The first removal fails and the next one succeeds, the way a daemon that
      # refuses once and then answers does.
      count=0
      if [ -n "$SHIM_RM_COUNTER" ] && [ -f "$SHIM_RM_COUNTER" ]; then count=$(cat "$SHIM_RM_COUNTER"); fi
      count=$((count + 1))
      if [ -n "$SHIM_RM_COUNTER" ]; then printf '%s' "$count" > "$SHIM_RM_COUNTER"; fi
      if [ "$count" -le 1 ]; then echo "permission denied" >&2; exit 1; fi
    fi
    if [ "$SHIM_RM" = "hang" ]; then exec sleep 600; fi
    exit 0 ;;
  *) exit 1 ;;
esac
`

// A process that starts the helper with no register callback and a 500 ms removal bound, then behaves as the
// mode says. The natural mode ends with no stop call, so the exit listener does the removal.
const childProgram = `import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startCaptureProvisioning } from ${JSON.stringify(helper)}
const mode = process.argv[2]
if (mode === 'no-ready') {
  writeFileSync(process.env.CHILD_PID_FILE, String(process.pid))
  console.error('STARTED WITHOUT READY')
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
const handle = startCaptureProvisioning(undefined, {
  removalTimeoutMs: 500,
  backoffMs: process.env.CHILD_BACKOFF ? JSON.parse(process.env.CHILD_BACKOFF) : [10, 10],
  ...(process.env.CHILD_BUDGET_MS ? { budgetMs: Number(process.env.CHILD_BUDGET_MS) } : {}),
})
if (!handle) { console.log('NULL'); process.exit(3) }
console.log('READY ' + handle.containerName)
if (mode === 'normal') { handle.stop(); process.exit(0) }
if (mode === 'twice') { handle.stop(); handle.stop(); process.exit(0) }
if (mode === 'error') { throw new Error('boom after start') }
if (mode === 'exit-seven') process.exitCode = 7
if (mode === 'idle') setInterval(() => {}, 1000)
if (mode === 'stopped-idle') { handle.stop(); setInterval(() => {}, 1000) }
if (mode === 'blocking') { spawnSync('sleep', ['2']); handle.stop(); setTimeout(() => { console.log('LOOP-CONTINUED'); process.exit(0) }, 500) }
`

let workdir: string
let childPath: string
let shimDir: string
let noDockerPath: string

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'capture-provisioning-'))
  shimDir = join(workdir, 'bin')
  noDockerPath = join(workdir, 'no-docker-bin')
  childPath = join(workdir, 'child.mjs')
  writeFileSync(childPath, childProgram)
  mkdirSync(shimDir, { recursive: true })
  mkdirSync(noDockerPath)
  writeFileSync(join(shimDir, 'docker'), dockerShim)
  chmodSync(join(shimDir, 'docker'), 0o755)
})

afterAll(() => {
  rmSync(workdir, { force: true, recursive: true })
})

async function waitForChildExit(child: ReturnType<typeof Bun.spawn>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`child did not exit within ${timeoutMs} ms`)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function terminateChild(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exited
  try {
    child.kill('SIGTERM')
  } catch {
    // The child may exit between the state check and the signal.
  }
  try {
    return await waitForChildExit(child, 1_000)
  } catch {
    // Escalate when graceful termination does not finish within its bound.
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The child may exit between the timeout and the signal.
  }
  return waitForChildExit(child, 1_000)
}

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: RegExp,
  timeoutMs = 10_000
): Promise<RegExpMatchArray> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`the stream ended before ${marker}: ${text}`)
      text += decoder.decode(value, { stream: true })
      const match = text.match(marker)
      if (match) return match
    }
  })()
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${marker} after ${timeoutMs} ms: ${text}`)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** One run of the child program with its own shim log. */
function environmentFor(mode: string, extra: Record<string, string> = {}) {
  const log = join(workdir, `shim-${Math.random().toString(16).slice(2)}.log`)
  return {
    log,
    environment: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      SHIM_LOG: log,
      SHIM_STATE: join(workdir, `state-${Math.random().toString(16).slice(2)}`),
      SHIM_COUNTER: join(workdir, `counter-${Math.random().toString(16).slice(2)}`),
      SHIM_VOLUME_INSPECT_COUNTER: join(
        workdir,
        `volume-inspect-counter-${Math.random().toString(16).slice(2)}`
      ),
      SHIM_RM_COUNTER: join(workdir, `rm-counter-${Math.random().toString(16).slice(2)}`),
      SHIM_RM: ['missing', 'fail', 'hang'].includes(mode) ? mode : 'ok',
      ...extra,
    } as Record<string, string>,
  }
}

function calls(log: string) {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
}

function removals(log: string) {
  return calls(log).filter((line) => line.startsWith('rm '))
}

async function startChild(
  mode: string,
  environment: Record<string, string>,
  readinessTimeoutMs = 10_000
) {
  const child = Bun.spawn([process.execPath, childPath, mode], {
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  try {
    // The no-ready proof times the readiness wait, not process startup. Its
    // separate, bounded stderr acknowledgement follows the PID write, so a
    // slow spawn cannot expire the 100 ms wait before the child is running.
    if (mode === 'no-ready') await readUntil(child.stderr, /STARTED WITHOUT READY/)
    const [, name] = await readUntil(
      child.stdout,
      /READY (adea-capture-prov-[0-9a-f]+)/,
      readinessTimeoutMs
    )
    return { child, name: name! }
  } catch (error) {
    await terminateChild(child)
    throw error
  }
}

function runImages(log: string) {
  return calls(log)
    .filter((line) => line.startsWith('run '))
    .map((line) => line.split(' ').at(-1))
}

describe('capture provisioning helper', () => {
  test('a rate-limited ECR pull falls over to the same digest on the mirror and removes that container', async () => {
    const { environment, log } = environmentFor('ok', { SHIM_RUN: 'ecr' })
    const { child, name } = await startChild('normal', environment)
    expect(await child.exited).toBe(0)
    const images = runImages(log)
    const digest = '@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
    expect(images).toEqual([
      `public.ecr.aws/docker/library/postgres:18-alpine${digest}`,
      `mirror.gcr.io/library/postgres:18-alpine${digest}`,
    ])
    expect(removals(log)).toEqual([`rm -f ${name}`])
  })

  test('a failing mirror does not hide Docker Hub after ECR is rate-limited', async () => {
    const { environment, log } = environmentFor('ok', { SHIM_RUN: 'mirror-fails' })
    const { child, name } = await startChild('normal', environment)
    expect(await child.exited).toBe(0)
    const digest = '@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
    expect(runImages(log)).toEqual([
      `public.ecr.aws/docker/library/postgres:18-alpine${digest}`,
      `mirror.gcr.io/library/postgres:18-alpine${digest}`,
      `docker.io/library/postgres:18-alpine${digest}`,
    ])
    expect(removals(log)).toEqual([`rm -f ${name}`])
  })

  test('a slow start is cut off by the shared deadline, fails the start and still cleans up', async () => {
    const { environment, log } = environmentFor('ok', {
      SHIM_RUN: 'slow',
      CHILD_BUDGET_MS: '800',
    })
    const startedAt = Date.now()
    const child = Bun.spawn([process.execPath, childPath, 'normal'], {
      env: environment,
      stderr: 'pipe',
      stdout: 'pipe',
    })
    expect(await child.exited).toBe(1)
    // The first attempt would sleep 5 s and the retries more; the deadline ends it far sooner.
    expect(Date.now() - startedAt).toBeLessThan(4_000)
    expect(runImages(log)).toHaveLength(1)
    const removed = removals(log)
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatch(/^rm -f adea-capture-prov-[0-9a-f]+$/)
  })

  test('a backoff longer than the time left ends the retries instead of sleeping past the deadline', async () => {
    const { environment, log } = environmentFor('ok', {
      SHIM_RUN: 'all',
      CHILD_BACKOFF: '[60000]',
      CHILD_BUDGET_MS: '2000',
    })
    const startedAt = Date.now()
    const child = Bun.spawn([process.execPath, childPath, 'normal'], {
      env: environment,
      stderr: 'pipe',
      stdout: 'pipe',
    })
    expect(await child.exited).toBe(1)
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    // One pass over the three registries, then no wait.
    expect(runImages(log)).toHaveLength(3)
    expect(removals(log)).toHaveLength(1)
  })

  test('registries that stay rate-limited fail the start after bounded retries and nothing leaks', async () => {
    const { environment, log } = environmentFor('ok', { SHIM_RUN: 'all' })
    const child = Bun.spawn([process.execPath, childPath, 'normal'], {
      env: environment,
      stderr: 'pipe',
      stdout: 'pipe',
    })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('toomanyrequests')
    // Three registries on the first pass and again after each of the two retries.
    expect(runImages(log)).toHaveLength(9)
    const removed = removals(log)
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatch(/^rm -f adea-capture-prov-[0-9a-f]+$/)
  })

  test('an unrelated start failure is not retried or sent to another registry', async () => {
    const { environment, log } = environmentFor('ok', { SHIM_RUN: 'fail' })
    const child = Bun.spawn([process.execPath, childPath, 'normal'], {
      env: environment,
      stderr: 'pipe',
      stdout: 'pipe',
    })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('manifest unknown')
    expect(runImages(log)).toHaveLength(1)
  })

  test('a normal exit removes exactly the container this invocation created', async () => {
    const { environment, log } = environmentFor('ok')
    const { child, name } = await startChild('normal', environment)
    expect(await child.exited).toBe(0)
    expect(removals(log)).toEqual([`rm -f ${name}`])
  })

  test('an error exit removes exactly that container, and the process still reports the error', async () => {
    const { environment, log } = environmentFor('ok')
    const child = Bun.spawn([process.execPath, childPath, 'error'], {
      env: environment,
      stderr: 'pipe',
      stdout: 'pipe',
    })
    expect(await child.exited).toBe(1)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain('boom after start')
    const removed = removals(log)
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatch(/^rm -f adea-capture-prov-[0-9a-f]+$/)
  })

  test('SIGTERM removes exactly that container, ends the process by SIGTERM, and leaves other processes alone', async () => {
    const { environment, log } = environmentFor('ok')
    const sibling = Bun.spawn(['sleep', '30'])
    try {
      const { child, name } = await startChild('idle', environment)
      child.kill('SIGTERM')
      await child.exited
      expect(child.signalCode).toBe('SIGTERM')
      expect(removals(log)).toEqual([`rm -f ${name}`])
      expect(sibling.exitCode).toBeNull()
    } finally {
      sibling.kill()
    }
  })

  test('SIGINT removes exactly that container and ends the process by SIGINT', async () => {
    const { environment, log } = environmentFor('ok')
    const { child, name } = await startChild('idle', environment)
    child.kill('SIGINT')
    await child.exited
    expect(child.signalCode).toBe('SIGINT')
    expect(removals(log)).toEqual([`rm -f ${name}`])
  })

  test('repeated stops and repeated signals remove the container once', async () => {
    const twice = environmentFor('ok')
    const stopped = await startChild('twice', twice.environment)
    expect(await stopped.child.exited).toBe(0)
    expect(removals(twice.log)).toEqual([`rm -f ${stopped.name}`])

    const signalled = environmentFor('ok')
    const repeated = await startChild('idle', signalled.environment)
    repeated.child.kill('SIGTERM')
    repeated.child.kill('SIGTERM')
    await repeated.child.exited
    expect(removals(signalled.log)).toEqual([`rm -f ${repeated.name}`])
  })

  test('a container Docker reports as absent counts as removed', async () => {
    const { environment, log } = environmentFor('missing')
    const { child, name } = await startChild('normal', environment)
    expect(await child.exited).toBe(0)
    expect(removals(log)).toEqual([`rm -f ${name}`])
  })

  test('a removal failure is reported with the exact container name, and the process exits non-zero', async () => {
    const { environment } = environmentFor('fail')
    const child = Bun.spawn([process.execPath, childPath, 'normal'], {
      env: environment,
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const stdout = await new Response(child.stdout).text()
    const name = stdout.match(/READY (adea-capture-prov-[0-9a-f]+)/)?.[1]
    expect(await child.exited).not.toBe(0)
    const stderr = await new Response(child.stderr).text()
    expect(name).toBeDefined()
    expect(stderr).toContain(`removing the throwaway capture provisioning container ${name} failed`)
  })

  test('a natural exit without stop removes exactly the container and exits 0', async () => {
    const { environment, log } = environmentFor('ok')
    const { child, name } = await startChild('natural', environment)
    expect(await child.exited).toBe(0)
    expect(removals(log)).toEqual([`rm -f ${name}`])
  })

  test('a natural exit whose removal fails exits 1 and names the container', async () => {
    const { environment, log } = environmentFor('fail')
    const { child, name } = await startChild('natural', environment)
    expect(await child.exited).toBe(1)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain(`removing the throwaway capture provisioning container ${name} failed`)
    expect(removals(log)).toEqual([`rm -f ${name}`])
  })

  test('a natural exit whose removal hangs is bounded, exits 1, and names the container', async () => {
    const { environment, log } = environmentFor('hang')
    const started = Date.now()
    const { child, name } = await startChild('natural', environment)
    expect(await child.exited).toBe(1)
    expect(Date.now() - started).toBeLessThan(15_000)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain(
      `removing the throwaway capture provisioning container ${name} timed out after 500 ms`
    )
    expect(removals(log)).toEqual([`rm -f ${name}`])
  }, 30_000)

  test('an existing failure status is kept when the removal fails', async () => {
    const { environment, log } = environmentFor('fail')
    const { child, name } = await startChild('exit-seven', environment)
    expect(await child.exited).toBe(7)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain(`removing the throwaway capture provisioning container ${name} failed`)
    expect(removals(log)).toEqual([`rm -f ${name}`])
  })

  test('without Docker the helper starts nothing and removes nothing', async () => {
    const log = join(workdir, 'no-docker.log')
    const child = Bun.spawn([process.execPath, childPath, 'idle'], {
      env: { PATH: noDockerPath, SHIM_LOG: log },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const stdout = await new Response(child.stdout).text()
    expect(stdout.trim()).toBe('NULL')
    expect(await child.exited).toBe(3)
    expect(existsSync(log)).toBe(false)
  })

  test('a child that never reports readiness is stopped after the bounded wait', async () => {
    const pidFile = join(workdir, 'no-ready-child.pid')
    const { environment } = environmentFor('ok', { CHILD_PID_FILE: pidFile })
    await expect(startChild('no-ready', environment, 100)).rejects.toThrow(/timed out waiting for/)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test('a signal after a normal stop still ends the process by that signal, and removes nothing twice', async () => {
    const { environment, log } = environmentFor('ok')
    const { child, name } = await startChild('stopped-idle', environment)
    child.kill('SIGTERM')
    await child.exited
    expect(child.signalCode).toBe('SIGTERM')
    expect(removals(log)).toEqual([`rm -f ${name}`])
  })

  test('a signal that arrives during a blocking call ends the process by that signal once the call returns', async () => {
    const { environment, log } = environmentFor('ok')
    const { child, name } = await startChild('blocking', environment)
    child.kill('SIGTERM')
    await child.exited
    // A process that carried on would exit 0 and print LOOP-CONTINUED, so a SIGTERM end is the proof it did not.
    expect(child.signalCode).toBe('SIGTERM')
    expect(removals(log)).toEqual([`rm -f ${name}`])
  })

  test('the runner ends by the signal its command ended by, after removing the instance it started', async () => {
    const { environment, log } = environmentFor('ok')
    const runner = resolve(import.meta.dir, 'run-with-capture-provisioning.mjs')
    const runnerProcess = Bun.spawn(
      [
        process.execPath,
        runner,
        '--',
        process.execPath,
        '-e',
        "process.kill(process.pid, 'SIGTERM')",
      ],
      { env: environment, stderr: 'pipe', stdout: 'pipe' }
    )
    await runnerProcess.exited
    expect(runnerProcess.signalCode).toBe('SIGTERM')
    const removed = removals(log)
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatch(/^rm -f adea-capture-prov-[0-9a-f]+$/)
  })

  test('every removal names the container the invocation created, and no other container is scanned or removed', async () => {
    const { environment, log } = environmentFor('ok')
    const { child, name } = await startChild('idle', environment)
    child.kill('SIGTERM')
    await child.exited
    for (const line of calls(log)) {
      expect(['info', 'run', 'port', 'exec', 'rm -f', 'inspect', 'volume']).toContain(
        line.startsWith('rm -f') ? 'rm -f' : line.split(' ')[0]!
      )
    }
    expect(removals(log).every((line) => line === `rm -f ${name}`)).toBe(true)
    // The only container the helper inspects is the one this invocation created.
    expect(
      calls(log)
        .filter((line) => line.startsWith('inspect '))
        .every((line) => line.endsWith(name))
    ).toBe(true)
    expect(calls(log).some((line) => line.startsWith('ps'))).toBe(false)
  })
})

describe('startFromCaptureImage deadline', () => {
  const limitedReply = {
    status: 125,
    stdout: '',
    stderr: 'docker: Error response from daemon: toomanyrequests: Data limit exceeded',
  }

  test('each attempt is told how much of the budget is left, and waits are never longer than that', async () => {
    const { startFromCaptureImage } = await import('./capture-provisioning.mjs')
    let clock = 0
    const told: number[] = []
    const slept: number[] = []
    const result = startFromCaptureImage(
      (_image: string, remainingMs: number) => {
        told.push(remainingMs)
        clock += 100
        return limitedReply
      },
      {
        backoffMs: [1_000, 5_000, 90_000],
        budgetMs: 20_000,
        now: () => clock,
        sleep: (ms: number) => {
          slept.push(ms)
          clock += ms
        },
      }
    )
    expect(result.status).toBe(125)
    expect(told[0]).toBe(20_000)
    expect(told.every((remaining, index) => index === 0 || remaining < told[index - 1]!)).toBe(true)
    // The 90 s wait does not fit in what is left, so it is skipped rather than slept.
    expect(slept).toEqual([1_000, 5_000])
    expect(clock).toBeLessThanOrEqual(20_000)
  })

  test('an exhausted budget stops before the next registry is tried', async () => {
    const { startFromCaptureImage } = await import('./capture-provisioning.mjs')
    let clock = 0
    let attempts = 0
    startFromCaptureImage(
      () => {
        attempts += 1
        clock += 600
        return limitedReply
      },
      { backoffMs: [], budgetMs: 1_000, now: () => clock, sleep: () => {} }
    )
    // The canonical attempt uses 600 ms, one fallback uses 600 more, and then nothing is left.
    expect(attempts).toBe(2)
  })
})

async function withInstrumentedCapture(
  settings: Record<string, string>,
  run: (
    log: string,
    owned: (event: string) => ReturnType<typeof process.listeners>
  ) => void | Promise<void>,
  script = dockerShim
) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-capture-unit-'))
  const previous = { env: process.env, exitCode: process.exitCode }
  const events = ['exit', 'SIGINT', 'SIGTERM']
  const listeners = new Map(events.map((event) => [event, new Set(process.listeners(event))]))
  const log = join(directory, 'calls')
  try {
    writeFileSync(log, '')
    writeFileSync(join(directory, 'docker'), script)
    chmodSync(join(directory, 'docker'), 0o755)
    process.env = {
      PATH: `${directory}:/usr/bin:/bin`,
      SHIM_LOG: log,
      SHIM_STATE: join(directory, 'state'),
      SHIM_COUNTER: join(directory, 'counter'),
      SHIM_VOLUME_INSPECT_COUNTER: join(directory, 'volume-inspect-counter'),
      SHIM_RM_COUNTER: join(directory, 'rm-counter'),
      ...settings,
    }
    await run(log, (event) =>
      process.listeners(event).filter((listener) => !listeners.get(event)?.has(listener))
    )
  } finally {
    // Normal stop intentionally retains signal listeners in production. The
    // unit owns and removes only the listeners created by its own handle.
    for (const event of events)
      for (const listener of process.listeners(event))
        if (!listeners.get(event)?.has(listener)) process.off(event, listener)
    process.env = previous.env
    // Bun ignores undefined assignments; restore the default successful status explicitly.
    process.exitCode = previous.exitCode ?? 0
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('instrumented capture ownership and cleanup with stub Docker', () => {
  test('registers before start, uses the mapped loopback port and removes its own container once', async () => {
    await withInstrumentedCapture({}, (log) => {
      let registered = ''
      const handle = startCaptureProvisioning(
        (candidate) => {
          registered = candidate.containerName
          expect(candidate.databaseUrl).toBeNull()
          expect(readFileSync(log, 'utf8')).not.toContain('run ')
        },
        { removalTimeoutMs: 2000, backoffMs: [] }
      )
      if (!handle) throw new Error('Stub daemon unavailable')
      try {
        expect(handle.containerName).toBe(registered)
        const target = new URL(handle.databaseUrl)
        expect(target.hostname).toBe('127.0.0.1')
        expect(target.port).toBe('54329')
        expect(target.pathname).toBe('/postgres')
      } finally {
        handle.stop()
      }
      handle.stop()
      const recordedCommands = readFileSync(log, 'utf8').trim().split('\n')
      expect(recordedCommands.filter((line) => line.startsWith('rm '))).toEqual([
        `rm -f ${registered}`,
      ])
      expect(recordedCommands.some((line) => line.includes('pg_isready -h 127.0.0.1'))).toBe(true)
    })
  })

  test('the removal takes the anonymous volume of its own container with it', async () => {
    await withInstrumentedCapture(
      {
        SHIM_MOUNTS: JSON.stringify([
          { Type: 'volume', Name: 'volume-anonymous-1', Destination: '/var/lib/postgresql' },
        ]),
        SHIM_ANONYMOUS: 'volume-anonymous-1',
      },
      (log) => {
        const handle = startCaptureProvisioning(undefined, {
          removalTimeoutMs: 2000,
          backoffMs: [],
        })
        if (!handle) throw new Error('Stub daemon unavailable')
        handle.stop()
        const commands = readFileSync(log, 'utf8').trim().split('\n')
        const containerRemoval = commands.indexOf(`rm -f ${handle.containerName}`)
        const volumeRemoval = commands.indexOf('volume rm volume-anonymous-1')
        expect(containerRemoval).toBeGreaterThanOrEqual(0)
        // The volume is taken after the container that held it, by the identity
        // that was read from that container's own mounts.
        expect(volumeRemoval).toBeGreaterThan(containerRemoval)
      }
    )
  })

  test('a named volume attached to the owned container is never removed', async () => {
    await withInstrumentedCapture(
      {
        SHIM_MOUNTS: JSON.stringify([
          { Type: 'volume', Name: 'volume-anonymous-1', Destination: '/var/lib/postgresql' },
          { Type: 'volume', Name: 'volume-named-shared', Destination: '/shared' },
        ]),
        SHIM_ANONYMOUS: 'volume-anonymous-1',
      },
      (log) => {
        const handle = startCaptureProvisioning(undefined, {
          removalTimeoutMs: 2000,
          backoffMs: [],
        })
        if (!handle) throw new Error('Stub daemon unavailable')
        handle.stop()
        const commands = readFileSync(log, 'utf8').trim().split('\n')
        expect(commands).toContain('volume rm volume-anonymous-1')
        // A named volume can belong to the operator or to another lane, so it
        // is never this helper's to remove.
        expect(commands).not.toContain('volume rm volume-named-shared')
      }
    )
  })

  test('a start that fails after the container started still takes its volume with it', async () => {
    await withInstrumentedCapture(
      {
        SHIM_MOUNTS: JSON.stringify([
          { Type: 'volume', Name: 'volume-anonymous-1', Destination: '/var/lib/postgresql' },
        ]),
        SHIM_ANONYMOUS: 'volume-anonymous-1',
      },
      (log) => {
        expect(() =>
          startCaptureProvisioning(undefined, { removalTimeoutMs: 2000, backoffMs: [] })
        ).toThrow('unreadable provisioning port mapping')
        const commands = readFileSync(log, 'utf8').trim().split('\n')
        expect(commands.some((line) => line.startsWith('rm -f '))).toBe(true)
        expect(commands).toContain('volume rm volume-anonymous-1')
      },
      dockerShim.replace('port) echo "127.0.0.1:54329"; exit 0 ;;', 'port) echo ""; exit 0 ;;')
    )
  })

  test('a container removal that fails is tried again by a repeated stop', async () => {
    await withInstrumentedCapture(
      {
        SHIM_RM: 'fail-once',
        SHIM_MOUNTS: JSON.stringify([
          { Type: 'volume', Name: 'volume-anonymous-1', Destination: '/var/lib/postgresql' },
        ]),
        SHIM_ANONYMOUS: 'volume-anonymous-1',
      },
      (log) => {
        const handle = startCaptureProvisioning(undefined, {
          removalTimeoutMs: 2000,
          inspectionTimeoutMs: 200,
          backoffMs: [],
        })
        if (!handle) throw new Error('Stub daemon unavailable')
        let failure = ''
        try {
          handle.stop()
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        expect(failure).toContain(
          `removing the throwaway capture provisioning container ${handle.containerName} failed`
        )
        const first = readFileSync(log, 'utf8').trim().split('\n')
        expect(first.filter((line) => line === `rm -f ${handle.containerName}`)).toHaveLength(1)
        // The removal was not verified, so a repeated stop tries it again.
        handle.stop()
        const second = readFileSync(log, 'utf8').trim().split('\n')
        expect(second.filter((line) => line === `rm -f ${handle.containerName}`)).toHaveLength(2)
      }
    )
  })

  test('an unresolved discovery keeps a repeated stop failing, with no known volume to remove', async () => {
    await withInstrumentedCapture({ SHIM_INSPECT: 'status' }, (log) => {
      const handle = startCaptureProvisioning(undefined, {
        removalTimeoutMs: 2000,
        inspectionTimeoutMs: 200,
        backoffMs: [],
      })
      if (!handle) throw new Error('Stub daemon unavailable')
      let failure = ''
      try {
        handle.stop()
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      expect(failure).toContain(
        `the throwaway capture provisioning container ${handle.containerName} could not be inspected: the inspection was refused`
      )
      const commands = readFileSync(log, 'utf8').trim().split('\n')
      // No volume was discovered, so none is removed, and none is invented.
      expect(commands.some((line) => line.startsWith('volume rm '))).toBe(false)
      // The container is verified gone, and the volumes it owned are still
      // unknown, so a repeated stop keeps failing.
      expect(commands).toContain(`rm -f ${handle.containerName}`)
      let repeated = ''
      try {
        handle.stop()
      } catch (error) {
        repeated = error instanceof Error ? error.message : String(error)
      }
      expect(repeated).toContain(
        `the anonymous volumes of the throwaway capture provisioning container ${handle.containerName} are still unknown`
      )
      expect(repeated).toContain('the container could not be inspected')
    })
  })

  test('a start that may have created the container keeps the volumes unknown', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await withInstrumentedCapture({ SHIM_RUN: 'fail' }, (log) => {
        // The run failed for a reason that does not prove the container was
        // never created.
        expect(() =>
          startCaptureProvisioning(undefined, {
            removalTimeoutMs: 2000,
            inspectionTimeoutMs: 200,
            backoffMs: [],
          })
        ).toThrow('starting the throwaway capture provisioning container')
        const reported = error.mock.calls.flat().join(' ')
        expect(reported).toContain(
          'the anonymous volumes of the throwaway capture provisioning container'
        )
        expect(reported).toContain(
          'the container may have been created and removed before its volumes could be read'
        )
        // The container is removed anyway, and no volume is removed on a guess.
        expect(readFileSync(log, 'utf8')).toContain('rm -f adea-capture-prov-')
        expect(readFileSync(log, 'utf8')).not.toContain('volume rm ')
      })
    } finally {
      error.mockRestore()
    }
  })

  test('an image that never arrived proves the container was never created', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await withInstrumentedCapture({ SHIM_RUN: 'all' }, () => {
        // The registry refused the image, so the daemon never created the
        // container, and there is nothing of it behind.
        expect(() =>
          startCaptureProvisioning(undefined, {
            removalTimeoutMs: 2000,
            inspectionTimeoutMs: 200,
            backoffMs: [],
          })
        ).toThrow('starting the throwaway capture provisioning container')
        const reported = error.mock.calls.flat().join(' ')
        expect(reported).not.toContain('are still unknown')
      })
    } finally {
      error.mockRestore()
    }
  })

  test('a candidate whose ownership cannot be read is kept, inspected again, and then removed', async () => {
    await withInstrumentedCapture(
      {
        SHIM_VOLUME_INSPECT: 'status-once',
        SHIM_MOUNTS: JSON.stringify([
          { Type: 'volume', Name: 'volume-anonymous-1', Destination: '/var/lib/postgresql' },
        ]),
        SHIM_ANONYMOUS: 'volume-anonymous-1',
      },
      (log) => {
        const handle = startCaptureProvisioning(undefined, {
          removalTimeoutMs: 2000,
          inspectionTimeoutMs: 200,
          backoffMs: [],
        })
        if (!handle) throw new Error('Stub daemon unavailable')
        let failure = ''
        try {
          handle.stop()
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        expect(failure).toContain(
          'the throwaway volume volume-anonymous-1 could not be inspected: the inspection was refused'
        )
        const commands = readFileSync(log, 'utf8').trim().split('\n')
        // The ownership is read again after the container is gone, and the
        // volume is only removed once its ownership is verified.
        const inspections = commands.filter((line) =>
          line.startsWith('volume inspect --format {{json .Labels}} volume-anonymous-1')
        )
        expect(inspections).toHaveLength(2)
        const removal = commands.indexOf('volume rm volume-anonymous-1')
        expect(removal).toBeGreaterThan(commands.indexOf(inspections[1]!))
        // The candidate is resolved, so a repeated stop is clean.
        handle.stop()
        const after = readFileSync(log, 'utf8').trim().split('\n')
        expect(after.filter((line) => line === 'volume rm volume-anonymous-1')).toHaveLength(1)
      }
    )
  })

  test('a container inspection that is refused is a failure, not an empty volume list', async () => {
    await withInstrumentedCapture(
      {
        SHIM_INSPECT: 'status',
        SHIM_MOUNTS: JSON.stringify([
          { Type: 'volume', Name: 'volume-anonymous-1', Destination: '/var/lib/postgresql' },
        ]),
        SHIM_ANONYMOUS: 'volume-anonymous-1',
      },
      (log) => {
        const handle = startCaptureProvisioning(undefined, {
          removalTimeoutMs: 2000,
          inspectionTimeoutMs: 200,
          backoffMs: [],
        })
        if (!handle) throw new Error('Stub daemon unavailable')
        let failure = ''
        try {
          handle.stop()
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        // An inspection that could not be trusted is never an absence.
        expect(failure).toContain(
          `the throwaway capture provisioning container ${handle.containerName} could not be inspected: the inspection was refused`
        )
        const commands = readFileSync(log, 'utf8').trim().split('\n')
        // The container is known and owned, so it is removed anyway.
        expect(commands).toContain(`rm -f ${handle.containerName}`)
        // The volumes it owned are unknown, so none is removed on a guess.
        expect(commands.some((line) => line.startsWith('volume rm '))).toBe(false)
      }
    )
  })

  test('a container inspection with unreadable output is a failure', async () => {
    await withInstrumentedCapture({ SHIM_INSPECT: 'malformed' }, (log) => {
      const handle = startCaptureProvisioning(undefined, {
        removalTimeoutMs: 2000,
        inspectionTimeoutMs: 200,
        backoffMs: [],
      })
      if (!handle) throw new Error('Stub daemon unavailable')
      let failure = ''
      try {
        handle.stop()
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      expect(failure).toContain(
        `the throwaway capture provisioning container ${handle.containerName} could not be inspected: the inspection returned unreadable output`
      )
      const commands = readFileSync(log, 'utf8').trim().split('\n')
      expect(commands).toContain(`rm -f ${handle.containerName}`)
    })
  })

  test('a container inspection that times out is a failure', async () => {
    await withInstrumentedCapture({ SHIM_INSPECT: 'hang' }, (log) => {
      const handle = startCaptureProvisioning(undefined, {
        removalTimeoutMs: 2000,
        inspectionTimeoutMs: 200,
        backoffMs: [],
      })
      if (!handle) throw new Error('Stub daemon unavailable')
      let failure = ''
      try {
        handle.stop()
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      expect(failure).toContain(
        `the throwaway capture provisioning container ${handle.containerName} could not be inspected: the inspection timed out`
      )
      const commands = readFileSync(log, 'utf8').trim().split('\n')
      expect(commands).toContain(`rm -f ${handle.containerName}`)
    })
  })

  test('a client that cannot be run at all is an inspection failure', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await withInstrumentedCapture({ SHIM_INSPECT: 'error' }, () => {
        // The client removes itself while the instance starts, so the cleanup
        // cannot ask Docker anything.
        expect(() =>
          startCaptureProvisioning(undefined, {
            removalTimeoutMs: 2000,
            inspectionTimeoutMs: 200,
            backoffMs: [],
          })
        ).toThrow()
        const reported = error.mock.calls.flat().join(' ')
        expect(reported).toContain('could not be inspected: the inspection failed')
      })
    } finally {
      error.mockRestore()
    }
  })

  test('a volume whose labels cannot be read is never removed and fails the cleanup', async () => {
    await withInstrumentedCapture(
      {
        SHIM_VOLUME_INSPECT: 'status',
        SHIM_MOUNTS: JSON.stringify([
          { Type: 'volume', Name: 'volume-anonymous-1', Destination: '/var/lib/postgresql' },
        ]),
        SHIM_ANONYMOUS: 'volume-anonymous-1',
      },
      (log) => {
        const handle = startCaptureProvisioning(undefined, {
          removalTimeoutMs: 2000,
          inspectionTimeoutMs: 200,
          backoffMs: [],
        })
        if (!handle) throw new Error('Stub daemon unavailable')
        let failure = ''
        try {
          handle.stop()
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        expect(failure).toContain(
          'the throwaway volume volume-anonymous-1 could not be inspected: the inspection was refused'
        )
        const commands = readFileSync(log, 'utf8').trim().split('\n')
        // A volume that could not be read is never removed on a guess.
        expect(commands.some((line) => line.startsWith('volume rm '))).toBe(false)
      }
    )
  })

  test('a failed volume deletion is retained, and a repeated stop removes it', async () => {
    await withInstrumentedCapture(
      {
        SHIM_VOLUME_RM: 'fail-once',
        SHIM_MOUNTS: JSON.stringify([
          { Type: 'volume', Name: 'volume-anonymous-1', Destination: '/var/lib/postgresql' },
        ]),
        SHIM_ANONYMOUS: 'volume-anonymous-1',
      },
      (log) => {
        const handle = startCaptureProvisioning(undefined, {
          removalTimeoutMs: 2000,
          inspectionTimeoutMs: 200,
          backoffMs: [],
        })
        if (!handle) throw new Error('Stub daemon unavailable')
        let failure = ''
        try {
          handle.stop()
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        expect(failure).toContain('removing the throwaway volume volume-anonymous-1 failed')
        const first = readFileSync(log, 'utf8').trim().split('\n')
        expect(first.filter((line) => line === `rm -f ${handle.containerName}`)).toHaveLength(1)
        expect(first.filter((line) => line === 'volume rm volume-anonymous-1')).toHaveLength(1)
        // The identity is retained, so a repeated stop removes it.
        handle.stop()
        const second = readFileSync(log, 'utf8').trim().split('\n')
        expect(second.filter((line) => line === 'volume rm volume-anonymous-1')).toHaveLength(2)
        expect(second.filter((line) => line === `rm -f ${handle.containerName}`)).toHaveLength(1)
      }
    )
  })

  test('every known volume is attempted even when one deletion fails', async () => {
    await withInstrumentedCapture(
      {
        SHIM_VOLUME_RM: 'fail-once',
        SHIM_MOUNTS: JSON.stringify([
          { Type: 'volume', Name: 'volume-anonymous-1', Destination: '/var/lib/postgresql' },
          { Type: 'volume', Name: 'volume-anonymous-2', Destination: '/var/lib/postgresql' },
        ]),
        SHIM_ANONYMOUS: 'volume-anonymous-1,volume-anonymous-2',
      },
      (log) => {
        const handle = startCaptureProvisioning(undefined, {
          removalTimeoutMs: 2000,
          inspectionTimeoutMs: 200,
          backoffMs: [],
        })
        if (!handle) throw new Error('Stub daemon unavailable')
        let failure = ''
        try {
          handle.stop()
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        expect(failure).toContain('removing the throwaway volume volume-anonymous-1 failed')
        const commands = readFileSync(log, 'utf8').trim().split('\n')
        // The second volume is attempted even though the first one failed.
        expect(commands).toContain('volume rm volume-anonymous-1')
        expect(commands).toContain('volume rm volume-anonymous-2')
      }
    )
  })

  test('a removal that times out leaves the volume pending and names it', async () => {
    await withInstrumentedCapture(
      {
        SHIM_RM: 'hang',
        SHIM_VOLUME_RM: 'in-use',
        SHIM_MOUNTS: JSON.stringify([
          { Type: 'volume', Name: 'volume-anonymous-1', Destination: '/var/lib/postgresql' },
        ]),
        SHIM_ANONYMOUS: 'volume-anonymous-1',
      },
      (log) => {
        const handle = startCaptureProvisioning(undefined, {
          removalTimeoutMs: 200,
          inspectionTimeoutMs: 200,
          backoffMs: [],
        })
        if (!handle) throw new Error('Stub daemon unavailable')
        let failure = ''
        try {
          handle.stop()
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        expect(failure).toContain(
          `removing the throwaway capture provisioning container ${handle.containerName} timed out after 200 ms`
        )
        // The container may still hold the volume, so the failure names it.
        expect(failure).toContain('volume-anonymous-1')
        const commands = readFileSync(log, 'utf8').trim().split('\n')
        // The volume is attempted, and it stays pending because the container may hold it.
        expect(commands).toContain('volume rm volume-anonymous-1')
      }
    )
  })

  test('unavailable Docker returns null before registering a handle', async () => {
    const previous = process.env
    let registered = false
    try {
      process.env = { PATH: noDockerPath }
      expect(dockerDaemonAvailable()).toBe(false)
      expect(
        startCaptureProvisioning(() => {
          registered = true
        })
      ).toBeNull()
      expect(registered).toBe(false)
    } finally {
      process.env = previous
    }
  })

  test('start failure and retry exhaustion both retain cleanup ownership', async () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const mode of ['fail', 'all'])
        await withInstrumentedCapture({ SHIM_RUN: mode }, (log) => {
          let name = ''
          expect(() =>
            startCaptureProvisioning(
              (handle) => {
                name = handle.containerName
              },
              { removalTimeoutMs: 2000, backoffMs: [0], budgetMs: 10000 }
            )
          ).toThrow('starting the throwaway capture provisioning container')
          expect(readFileSync(log, 'utf8')).toContain(`rm -f ${name}`)
          if (mode === 'all')
            expect(
              readFileSync(log, 'utf8')
                .split('\n')
                .filter((line) => line.startsWith('run '))
            ).toHaveLength(6)
        })
    } finally {
      warning.mockRestore()
    }
  })

  test('a broken port mapping removes the started container rather than returning an unusable URL', async () => {
    await withInstrumentedCapture(
      {},
      (log) => {
        expect(() =>
          startCaptureProvisioning(undefined, { removalTimeoutMs: 2000, backoffMs: [] })
        ).toThrow('unreadable provisioning port mapping')
        expect(readFileSync(log, 'utf8')).toContain('rm -f adea-capture-prov-')
      },
      dockerShim.replace('port) echo "127.0.0.1:54329"; exit 0 ;;', 'port) echo ""; exit 0 ;;')
    )
  })

  test('owned signal callback removes once and re-raises only that signal', async () => {
    const kill = spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await withInstrumentedCapture({}, (log, owned) => {
        const handle = startCaptureProvisioning(undefined, {
          removalTimeoutMs: 2000,
          backoffMs: [],
        })
        if (!handle) throw new Error('Stub daemon unavailable')
        const signal = owned('SIGTERM')[0]
        expect(signal).toBeDefined()
        signal?.()
        expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM')
        expect(readFileSync(log, 'utf8')).toContain(`rm -f ${handle.containerName}`)
        expect(owned('SIGTERM')).toHaveLength(0)
      })
    } finally {
      kill.mockRestore()
    }
  })

  test('owned exit cleanup failure fails a clean exit and preserves an existing failure', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const code of [0, 7])
        await withInstrumentedCapture({ SHIM_RM: 'fail' }, (_log, owned) => {
          const handle = startCaptureProvisioning(undefined, {
            removalTimeoutMs: 2000,
            backoffMs: [],
          })
          if (!handle) throw new Error('Stub daemon unavailable')
          const exit = owned('exit')[0]
          process.exitCode = code
          exit?.(code)
          expect(process.exitCode).toBe(code === 0 ? 1 : 7)
          expect(error.mock.calls.flat().join(' ')).toContain(handle.containerName)
        })
    } finally {
      error.mockRestore()
    }
  })

  test('direct Docker command errors preserve context and do not silently succeed', async () => {
    await withInstrumentedCapture({ SHIM_RUN: 'fail' }, () => {
      expect(() => dockerCaptureRun(['run', 'fixture'], 'fixture operation', 2000)).toThrow(
        'fixture operation failed: docker: Error response from daemon: manifest unknown'
      )
    })
  })
})
