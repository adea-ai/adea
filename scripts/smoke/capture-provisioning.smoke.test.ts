// Real-Docker smoke test for the capture provisioning helper. runOwnedSmoke starts one sentinel container, spawns
// one helper child, checks that the child's instance answers a query, then stops the child with SIGTERM and runs
// its cleanup. The test checks that the helper removed exactly its own instance, and that the sentinel was still
// running at that point. It needs a Docker daemon and fails without one, because a skipped check is not a passing
// check. Run it through the heavy-validation wrapper:
//
//   python3 <fleet-heavy> -- bun test scripts/smoke/capture-provisioning.smoke.test.ts
//
// It sits outside scripts/*.test.ts, so the unit coverage lane never starts Docker. The failure paths of the
// lifecycle run without Docker in scripts/capture-provisioning-smoke-faults.test.ts.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { dockerDaemonAvailable } from '../capture-provisioning.mjs'
import { runOwnedSmoke } from './capture-provisioning-run.mjs'

const helper = resolve(import.meta.dir, '..', 'capture-provisioning.mjs')

// The child names its instance through the register callback, which runs before docker run, so cleanup can remove
// that exact instance even if the child is killed before it is ready. It then runs one query through the URL the
// helper returns. It prints only names and the query result, never the URL, which carries the instance password.
const childProgram = `import { startCaptureProvisioning } from ${JSON.stringify(helper)}
const handle = startCaptureProvisioning((owned) => { console.log('OWNED ' + owned.containerName) })
if (!handle) { console.log('NULL'); process.exit(3) }
const sql = new Bun.SQL(handle.databaseUrl)
const [row] = await sql.unsafe('select 1 as ok')
await sql.close()
console.log('READY ' + handle.containerName + ' ' + row.ok)
setInterval(() => {}, 1000)
`

let workdir
let childPath

// What a volume inspection answered: the volume is there, Docker confirmed it
// is gone, or the answer could not be trusted. Only the confirmed absence is an
// absence: an inspection that failed or timed out says nothing about the
// volume, and never that it is gone.
type VolumeState = 'present' | 'absent' | 'unknown'

type DockerReply = { error?: Error; status: number | null; stderr: string; stdout: string }

// The Docker command the checker uses. It is injectable, so the failure paths
// are proved without a daemon.
const dockerCommand = (args: string[]): DockerReply => {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
  })
  return {
    error: result.error,
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

// The state of one volume on the host.
function inspectVolume(
  volume: string,
  docker: (args: string[]) => DockerReply = dockerCommand
): VolumeState {
  const result = docker(['volume', 'inspect', volume])
  if (result.error) return 'unknown'
  if (result.status === 0) return 'present'
  if (/no such volume/iu.test(result.stderr)) return 'absent'
  return 'unknown'
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'capture-provisioning-smoke-'))
  childPath = join(workdir, 'child.mjs')
  writeFileSync(childPath, childProgram)
})

afterAll(() => {
  rmSync(workdir, { force: true, recursive: true })
})

test('SIGTERM removes exactly the container the helper created and leaves a same-shaped sentinel running', async () => {
  if (!dockerDaemonAvailable()) {
    throw new Error('the capture provisioning smoke test requires a running Docker daemon')
  }
  // Each bound in the lifecycle is shorter than this timeout, so a stuck step fails the test and cleanup still runs.
  const observed = await runOwnedSmoke({ childPath })
  expect(observed.running).toBe(true)
  expect(observed.signal).toBe('SIGTERM')
  expect(observed.removed).toBe(true)
  expect(observed.sentinelRunning).toBe(true)
  // The helper took the anonymous volume Docker created for its own container with it.
  expect(observed.ownedVolumes.length).toBeGreaterThan(0)
  expect(observed.ownedVolumeRemoved).toBe(true)
  // The sentinel's own anonymous volume is another container's, and the helper left it alone.
  expect(observed.sentinelVolumes.length).toBeGreaterThan(0)
  expect(observed.sentinelVolumeKept).toBe(true)
  // The lifecycle's own cleanup removes the volumes it owns, so nothing it started is left behind.
  // A volume that cannot be inspected is unknown, never absent, so the proof only
  // passes when Docker confirmed that the volume is gone.
  for (const volume of [...observed.ownedVolumes, ...observed.sentinelVolumes]) {
    expect(inspectVolume(volume)).toBe('absent')
  }
  expect(observed.pendingVolumes).toEqual([])
}, 900_000)

test('a refused volume inspection is unknown, never an absence', () => {
  expect(
    inspectVolume('volume-x', () => ({ status: 1, stderr: 'permission denied', stdout: '' }))
  ).toBe('unknown')
})

test('a volume inspection that times out is unknown, never an absence', () => {
  expect(
    inspectVolume('volume-x', () => ({
      error: new Error('spawnSync docker ETIMEDOUT'),
      status: null,
      stderr: '',
      stdout: '',
    }))
  ).toBe('unknown')
})

test('only a confirmed absent volume is an absence', () => {
  expect(
    inspectVolume('volume-x', () => ({
      status: 1,
      stderr: 'Error: no such volume: volume-x',
      stdout: '',
    }))
  ).toBe('absent')
})

test('a volume that is there is present', () => {
  expect(inspectVolume('volume-x', () => ({ status: 0, stderr: '', stdout: '[]' }))).toBe('present')
})
