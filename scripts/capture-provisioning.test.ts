// Subprocess and signal tests for the capture provisioning helper. Docker is replaced by a shim on PATH
// that records every call and answers the subcommands the helper uses, so these tests need no daemon and
// never touch a real container. The real-Docker path is covered by scripts/smoke/capture-provisioning.smoke.test.ts.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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

const helper = resolve(import.meta.dir, 'capture-provisioning.mjs')

// Records every call to its log, answers the helper's subcommands, and honours SHIM_RM for removal.
// The hang mode replaces the shell with sleep, so a killed removal leaves no process behind.
const dockerShim = `#!/bin/sh
echo "$*" >> "$SHIM_LOG"
case "$1" in
  info) exit 0 ;;
  run) exit 0 ;;
  port) echo "127.0.0.1:54329"; exit 0 ;;
  exec) exit 0 ;;
  rm)
    if [ "$SHIM_RM" = "missing" ]; then echo "Error response from daemon: No such container: $3" >&2; exit 1; fi
    if [ "$SHIM_RM" = "fail" ]; then echo "permission denied" >&2; exit 1; fi
    if [ "$SHIM_RM" = "hang" ]; then exec sleep 600; fi
    exit 0 ;;
  *) exit 1 ;;
esac
`

// A process that starts the helper with no register callback and a 500 ms removal bound, then behaves as the
// mode says. The natural mode ends with no stop call, so the exit listener does the removal.
const childProgram = `import { spawnSync } from 'node:child_process'
import { startCaptureProvisioning } from ${JSON.stringify(helper)}
const mode = process.argv[2]
const handle = startCaptureProvisioning(undefined, { removalTimeoutMs: 500 })
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

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'capture-provisioning-'))
  shimDir = join(workdir, 'bin')
  childPath = join(workdir, 'child.mjs')
  writeFileSync(childPath, childProgram)
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(join(shimDir, 'docker'), dockerShim)
  chmodSync(join(shimDir, 'docker'), 0o755)
})

afterAll(() => {
  rmSync(workdir, { force: true, recursive: true })
})

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: RegExp
): Promise<RegExpMatchArray> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`the stream ended before ${marker}: ${text}`)
    text += decoder.decode(value, { stream: true })
    const match = text.match(marker)
    if (match) {
      reader.releaseLock()
      return match
    }
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

async function startChild(mode: string, environment: Record<string, string>) {
  const child = Bun.spawn([process.execPath, childPath, mode], {
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [, name] = await readUntil(child.stdout, /READY (adea-capture-prov-[0-9a-f]+)/)
  return { child, name: name! }
}

describe('capture provisioning helper', () => {
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
      env: { PATH: '/usr/bin:/bin', SHIM_LOG: log },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const stdout = await new Response(child.stdout).text()
    expect(stdout.trim()).toBe('NULL')
    expect(await child.exited).toBe(3)
    expect(existsSync(log)).toBe(false)
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
      expect(['info', 'run', 'port', 'exec', 'rm -f']).toContain(
        line.startsWith('rm -f') ? 'rm -f' : line.split(' ')[0]!
      )
    }
    expect(removals(log).every((line) => line === `rm -f ${name}`)).toBe(true)
    expect(calls(log).some((line) => line.startsWith('ps'))).toBe(false)
  })
})
