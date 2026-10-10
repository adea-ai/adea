// Real-Docker smoke test for the capture provisioning helper. It runs one helper instance in a child
// process, checks that the instance answers a query, then stops that child with SIGTERM. The check is that
// exactly the instance the helper created is removed, and that a sentinel container with the same name
// shape is left running. The test names and removes only the containers it created, and it signals only the
// child it spawned. It needs a Docker daemon and fails without one, because a skipped check is not a passing
// check. Run it through the heavy-validation wrapper:
//
//   python3 <fleet-heavy> -- bun test scripts/smoke/capture-provisioning.smoke.test.ts
//
// It sits outside scripts/*.test.ts, so the unit coverage lane never starts Docker.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { captureProvisioningImage, dockerDaemonAvailable } from '../capture-provisioning.mjs'

const helper = resolve(import.meta.dir, '..', 'capture-provisioning.mjs')

// Every wait and command has a bound. The bounds add up to less than the test timeout, so the finally block
// always runs, and a stuck Docker daemon or child fails the test instead of holding a heavy-validation slot.
const startSentinelMs = 180_000
const dockerCommandMs = 60_000
const namedMs = 60_000
const readyMs = 200_000
const stopAfterTermMs = 60_000
const removeMs = 60_000

// The child names its instance through the register callback, which runs before docker run. The test can then
// remove that exact instance even if the child is killed before it is ready. The child then runs one query
// through the URL the helper returns. It prints only names and the query result, never the URL, which carries
// the instance password.
const childProgram = `import { startCaptureProvisioning } from ${JSON.stringify(helper)}
const handle = startCaptureProvisioning((owned) => { console.log('OWNED ' + owned.containerName) })
if (!handle) { console.log('NULL'); process.exit(3) }
const sql = new Bun.SQL(handle.databaseUrl)
const [row] = await sql.unsafe('select 1 as ok')
await sql.close()
console.log('READY ' + handle.containerName + ' ' + row.ok)
setInterval(() => {}, 1000)
`

type Child = ReturnType<typeof Bun.spawn>

let workdir: string
let childPath: string

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'capture-provisioning-smoke-'))
  childPath = join(workdir, 'child.mjs')
  writeFileSync(childPath, childProgram)
})

afterAll(() => {
  rmSync(workdir, { force: true, recursive: true })
})

function docker(args: string[], timeoutMs = dockerCommandMs) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
}

function isRunning(name: string) {
  const result = docker(['container', 'inspect', '--format', '{{.State.Running}}', name])
  return result.status === 0 && result.stdout.trim() === 'true'
}

function exists(name: string) {
  return docker(['container', 'inspect', name]).status === 0
}

// Removes one container by its exact name. A container Docker reports as absent is already gone.
function removeNamed(name: string) {
  const result = docker(['rm', '-f', name], removeMs)
  if (result.error) throw new Error(`removing ${name} failed: ${result.error.message}`)
  if (result.status !== 0 && !result.stderr.includes('No such container')) {
    throw new Error(`removing ${name} failed: ${result.stderr.trim()}`)
  }
}

// Reads one child's stdout in order, so the OWNED and READY lines come from the same stream.
function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  return async (marker: RegExp) => {
    for (;;) {
      const match = pending.match(marker)
      if (match?.index !== undefined) {
        pending = pending.slice(match.index + match[0].length)
        return match
      }
      const { value, done } = await reader.read()
      if (done) throw new Error(`the helper child ended before ${marker}: ${pending}`)
      pending += decoder.decode(value, { stream: true })
    }
  }
}

// Rejects when the work outlives its bound. The timer is cleared either way, so a finished wait keeps nothing alive.
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

// Stops the child this test spawned, and nothing else. SIGTERM lets the helper remove its instance. SIGKILL is
// the bounded fallback, and the helper cannot remove its instance after SIGKILL, so the test removes it by name.
async function stopChild(child: Child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await within(child.exited, stopAfterTermMs, 'the helper child after SIGTERM')
  } catch (error) {
    child.kill('SIGKILL')
    await child.exited
    throw new Error(`${(error as Error).message}; the child was killed with SIGKILL`, {
      cause: error,
    })
  }
}

test('SIGTERM removes exactly the container the helper created and leaves a same-shaped sentinel running', async () => {
  if (!dockerDaemonAvailable()) {
    throw new Error('the capture provisioning smoke test requires a running Docker daemon')
  }
  // The sentinel has the helper's name shape, so a cleanup that matched by prefix would remove it.
  const sentinel = `adea-capture-prov-${randomBytes(6).toString('hex')}`
  const started = docker(
    ['run', '-d', '--name', sentinel, '--entrypoint', 'sleep', captureProvisioningImage, '600'],
    startSentinelMs
  )
  if (started.status !== 0) {
    throw new Error(`starting the sentinel container failed: ${started.stderr.trim()}`)
  }

  // Spawned before the try, so the finally block always owns the child it stops.
  const child = Bun.spawn([process.execPath, childPath], { stderr: 'inherit', stdout: 'pipe' })
  const nextLine = lineReader(child.stdout)
  let owned: string | undefined
  try {
    const claim = await within(
      nextLine(/OWNED (adea-capture-prov-[0-9a-f]+)/),
      namedMs,
      'the helper child naming its instance'
    )
    owned = claim[1]
    const ready = await within(
      nextLine(/READY (adea-capture-prov-[0-9a-f]+) 1/),
      readyMs,
      'the helper child becoming ready'
    )
    const name = ready[1]!
    expect(name).toBe(owned)
    expect(isRunning(name)).toBe(true)

    await stopChild(child)
    expect(child.signalCode).toBe('SIGTERM')
    expect(exists(name)).toBe(false)
    expect(isRunning(sentinel)).toBe(true)
  } finally {
    try {
      await stopChild(child)
    } finally {
      if (owned !== undefined) removeNamed(owned)
      removeNamed(sentinel)
    }
  }
}, 900_000)
