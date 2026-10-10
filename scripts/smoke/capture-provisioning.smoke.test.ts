// Real-Docker smoke test for the capture provisioning helper. It runs one helper instance in a child
// process, checks that the instance answers a query, then stops the child with SIGTERM. The check is that
// exactly the instance the helper created is removed, and that a sentinel container with the same name
// shape is left running. The test names and removes only the containers it created. It needs a Docker
// daemon and fails without one, because a skipped check is not a passing check. Run it through the
// heavy-validation wrapper:
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

// The child starts the helper and runs one query through the URL the helper returns. It prints only the
// container name and the query result, never the URL, which carries the instance password. Then it waits
// for the test to stop it.
const childProgram = `import { startCaptureProvisioning } from ${JSON.stringify(helper)}
const handle = startCaptureProvisioning()
if (!handle) { console.log('NULL'); process.exit(3) }
const sql = new Bun.SQL(handle.databaseUrl)
const [row] = await sql.unsafe('select 1 as ok')
await sql.close()
console.log('READY ' + handle.containerName + ' ' + row.ok)
setInterval(() => {}, 1000)
`

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

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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
  const result = docker(['rm', '-f', name])
  if (result.status !== 0 && !result.stderr.includes('No such container')) {
    throw new Error(`removing ${name} failed: ${result.stderr.trim()}`)
  }
}

async function readReadyName(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`the helper child ended before it was ready: ${text}`)
      text += decoder.decode(value, { stream: true })
      const match = text.match(/READY (adea-capture-prov-[0-9a-f]+) 1/)
      if (match) return match[1]!
    }
  } finally {
    reader.releaseLock()
  }
}

test('SIGTERM removes exactly the container the helper created and leaves a same-shaped sentinel running', async () => {
  if (!dockerDaemonAvailable()) {
    throw new Error('the capture provisioning smoke test requires a running Docker daemon')
  }
  // The sentinel has the helper's name shape, so a cleanup that matched by prefix would remove it.
  const sentinel = `adea-capture-prov-${randomBytes(6).toString('hex')}`
  const started = docker([
    'run',
    '-d',
    '--name',
    sentinel,
    '--entrypoint',
    'sleep',
    captureProvisioningImage,
    '600',
  ])
  if (started.status !== 0) {
    throw new Error(`starting the sentinel container failed: ${started.stderr.trim()}`)
  }

  let name: string | undefined
  try {
    const child = Bun.spawn([process.execPath, childPath], { stderr: 'inherit', stdout: 'pipe' })
    name = await readReadyName(child.stdout)
    expect(isRunning(name)).toBe(true)

    child.kill('SIGTERM')
    await child.exited
    expect(child.signalCode).toBe('SIGTERM')
    expect(exists(name)).toBe(false)
    expect(isRunning(sentinel)).toBe(true)
  } finally {
    if (name !== undefined) removeNamed(name)
    removeNamed(sentinel)
  }
}, 300_000)
