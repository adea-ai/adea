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
}, 900_000)
