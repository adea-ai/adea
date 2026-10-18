import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  FactoryFixtureFailure,
  boundedFactoryWait,
  factoryFailureRecord,
  runFactoryProof,
  startFactoryChild,
} from '../fixtures/lead-production-factory-process.mjs'

const directory = mkdtempSync(join(tmpdir(), 'adea-factory-process-'))
const canary = 'SYNTHETIC_CREDENTIAL_CANARY_DO_NOT_LOG'
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function spawnFailure(binary: string) {
  let host: ReturnType<typeof startFactoryChild> | undefined
  const records: unknown[] = []
  let databaseClosed = 0
  const reader = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') })
  const url = `http://127.0.0.1:${reader.port}`
  const status = await runFactoryProof(
    async () => {
      host = startFactoryChild(binary, [], { cwd: directory })
      await host.ready()
    },
    {
      phase: () => 'host-launch',
      readerRequests: () => 0,
      actions: [
        () => host?.closeOwned(),
        () => reader.stop(true),
        () => {
          databaseClosed++
        },
      ],
    },
    (record: unknown) => records.push(record)
  )
  await host?.closed
  expect(status).toBe(1)
  expect(databaseClosed).toBe(1) // Cleanup callback; no PostgreSQL is started by fault tests.
  await expect(fetch(url)).rejects.toThrow()
  expect(JSON.stringify(records)).not.toContain(canary)
  return records
}

describe('production factory child failures', () => {
  test('missing binary settles startup and closes every owned resource', async () => {
    const records = await spawnFailure(join(directory, `${canary}-missing`))
    expect(records).toEqual(
      [factoryFailureRecord('host-launch', { code: 'ignored' })].map((record) => ({
        ...record,
        code: 'HOST_BINARY_MISSING',
      }))
    )
  })
  test('non-executable binary settles error/close once and closes owned resources', async () => {
    const binary = join(directory, `${canary}-not-executable`)
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o600)
    const records = await spawnFailure(binary)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ code: 'HOST_BINARY_NOT_EXECUTABLE', phase: 'host-launch' })
  })
  test('primary, cleanup and invalid phase canaries never enter failure records', async () => {
    const records: unknown[] = []
    const failure = new Error(canary)
    Object.assign(failure, { stderr: canary, stack: canary, code: canary })
    const status = await runFactoryProof(
      async () => {
        throw failure
      },
      {
        phase: () => canary,
        readerRequests: () => Number.POSITIVE_INFINITY,
        actions: [
          () => {
            throw failure
          },
          () => {
            records.push({ cleanupCompleted: true })
          },
        ],
      },
      (record: unknown) => records.push(record)
    )
    expect(status).toBe(1)
    expect(JSON.stringify(records)).not.toContain(canary)
    expect(records).toEqual([
      {
        schemaVersion: 'adea-production-factory-failure/v1',
        phase: 'preflight',
        code: 'PROOF_FAILED',
        readerRequests: 0,
      },
      {
        schemaVersion: 'adea-production-factory-failure/v1',
        phase: 'cleanup',
        code: 'PROOF_FAILED',
        readerRequests: 0,
      },
      { cleanupCompleted: true },
    ])
  })
  test('startup stderr is drained without disclosure or an uncaught raw stack', () => {
    const helper = new URL('../fixtures/lead-production-factory-process.mjs', import.meta.url).href
    const driver = join(directory, 'canary-driver.mjs')
    writeFileSync(
      driver,
      `import { startFactoryChild, runFactoryProof } from ${JSON.stringify(helper)};
let host;
process.exitCode = await runFactoryProof(async () => {
host = startFactoryChild(process.execPath, ['--eval', ${JSON.stringify(`console.error('${canary}'); throw Error('${canary}')`)}], {});
await host.ready();
}, {phase:()=> 'host-launch',readerRequests:()=>0,actions:[()=>host?.closeOwned(),()=>{throw Error('${canary}')}]});`
    )
    const result = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 5_000 })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain(canary)
    const records = result.stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ code: 'HOST_EXIT_BEFORE_READY' })
    expect(records[1]).toMatchObject({ code: 'PROOF_FAILED', phase: 'cleanup' })
  })
  test('failed preflight command stderr never reaches parent output', () => {
    const helper = new URL('../fixtures/lead-production-factory-process.mjs', import.meta.url).href
    const preflight = new URL('../fixtures/lead-production-factory-preflight.mjs', import.meta.url)
      .href
    const driver = join(directory, 'preflight-canary-driver.mjs')
    writeFileSync(
      driver,
      `import {runFactoryProof} from ${JSON.stringify(helper)};
import {verifyInstalledPackagePayload} from ${JSON.stringify(preflight)};
process.exitCode=await runFactoryProof(async()=>verifyInstalledPackagePayload({archivePath:${JSON.stringify(join(directory, canary))}},${JSON.stringify(directory)}),{phase:()=> 'preflight',readerRequests:()=>0,actions:[]});`
    )
    const result = spawnSync('node', [driver], { encoding: 'utf8', timeout: 5_000 })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain(canary)
    expect(JSON.parse(result.stderr)).toMatchObject({ phase: 'preflight', code: 'PROOF_FAILED' })
  })
  test('diagnostic captures a changing code getter exactly once', () => {
    const failure = new FactoryFixtureFailure('PROOF_FAILED')
    let reads = 0
    Object.defineProperty(failure, 'code', { get: () => (++reads === 1 ? 'PROOF_FAILED' : canary) })
    const record = factoryFailureRecord('prepare', failure, 1)
    expect(reads).toBe(1)
    expect(record.code).toBe('PROOF_FAILED')
    expect(JSON.stringify(record)).not.toContain(canary)
  })
  test('diagnostic throwing code getter cannot abort remaining cleanup', async () => {
    const failure = new FactoryFixtureFailure('PROOF_FAILED')
    let reads = 0
    Object.defineProperty(failure, 'code', {
      get: () => {
        reads++
        throw Error(canary)
      },
    })
    const records: unknown[] = [],
      completed: string[] = []
    const status = await runFactoryProof(
      async () => {
        throw failure
      },
      {
        phase: () => 'prepare',
        readerRequests: () => 0,
        actions: [
          () => {
            completed.push('first')
            throw failure
          },
          () => {
            completed.push('last')
          },
        ],
      },
      (record: unknown) => {
        records.push(record)
      }
    )
    expect(status).toBe(1)
    expect(reads).toBe(2)
    expect(completed).toEqual(['first', 'last'])
    expect(records).toHaveLength(2)
    expect(JSON.stringify(records)).not.toContain(canary)
    expect(records).toEqual([
      {
        schemaVersion: 'adea-production-factory-failure/v1',
        phase: 'prepare',
        code: 'PROOF_FAILED',
        readerRequests: 0,
      },
      {
        schemaVersion: 'adea-production-factory-failure/v1',
        phase: 'cleanup',
        code: 'PROOF_FAILED',
        readerRequests: 0,
      },
    ])
  })
  test('diagnostic context and rejected output cannot interrupt cleanup', async () => {
    const completed: string[] = [],
      records: unknown[] = []
    const status = await runFactoryProof(
      async () => {
        throw Error(canary)
      },
      {
        phase: () => {
          throw Error(canary)
        },
        readerRequests: () => {
          throw Error(canary)
        },
        actions: [
          () => {
            completed.push('first')
            throw Error(canary)
          },
          () => {
            completed.push('last')
          },
        ],
      },
      async (record: unknown) => {
        records.push(record)
        throw Error(canary)
      }
    )
    expect(status).toBe(1)
    expect(completed).toEqual(['first', 'last'])
    expect(records).toHaveLength(2)
    expect(JSON.stringify(records)).not.toContain(canary)
  })

  test('pending diagnostic output cannot hold resource cleanup', async () => {
    let completed = false
    const status = await runFactoryProof(
      async () => {
        throw Error(canary)
      },
      {
        phase: () => 'prepare',
        readerRequests: () => 0,
        actions: [
          () => {
            completed = true
          },
        ],
      },
      () => new Promise(() => {})
    )
    expect(status).toBe(1)
    expect(completed).toBe(true)
  })
})

test('bounded waits settle values and errors, and timeouts use only an allow-listed code', async () => {
  expect(await boundedFactoryWait(Promise.resolve('ready'), 1000, 'HOST_LAUNCH_TIMEOUT')).toBe(
    'ready'
  )
  const failure = new Error('synthetic rejected wait')
  await expect(
    boundedFactoryWait(Promise.reject(failure), 1000, 'HOST_LAUNCH_TIMEOUT')
  ).rejects.toBe(failure)
  await expect(
    boundedFactoryWait(new Promise(() => {}), 1, 'HOST_CONTROL_TIMEOUT')
  ).rejects.toMatchObject({ code: 'HOST_CONTROL_TIMEOUT' })
  expect(new FactoryFixtureFailure('untrusted-code').code).toBe('PROOF_FAILED')
  expect(factoryFailureRecord('dispatch', { code: 'ERR_ASSERTION' }, 2)).toMatchObject({
    code: 'PROOF_ASSERTION_FAILED',
    readerRequests: 2,
  })
})

function syntheticChild(program: string) {
  return startFactoryChild(process.execPath, ['--eval', program], { cwd: directory })
}
const childPrelude = `const {createInterface}=require('node:readline'); const lines=createInterface({input:process.stdin}); console.log('ignored raw line'); console.log(JSON.stringify({baseUrl:'http://127.0.0.1:1'}));`

test('owned synthetic child settles ready, correlates controls and closes idempotently', async () => {
  const host = syntheticChild(
    childPrelude +
      `lines.on('line', line=>{ const {id,command}=JSON.parse(line); console.log(JSON.stringify({controlId:'unmatched',data:'ignored'})); console.log(JSON.stringify({controlId:id,data:{command}})); if(command==='close') lines.close(); });`
  )
  try {
    await expect(host.control('evidence')).rejects.toMatchObject({
      code: 'HOST_CONTROL_UNAVAILABLE',
    })
    expect(await host.ready()).toEqual({ baseUrl: 'http://127.0.0.1:1' })
    expect(await host.ready()).toEqual({ baseUrl: 'http://127.0.0.1:1' })
    await expect(host.control('invalid')).rejects.toMatchObject({
      code: 'HOST_CONTROL_UNAVAILABLE',
    })
    expect(await host.control('evidence')).toEqual({ command: 'evidence' })
    expect(await host.control('drain')).toEqual({ command: 'drain' })
  } finally {
    await host.closeOwned()
  }
  await host.closed
  await host.closeOwned()
  await expect(host.control('evidence')).rejects.toMatchObject({ code: 'HOST_CONTROL_UNAVAILABLE' })
})

test('an owned child exiting during a control refuses the pending reply and is reaped', async () => {
  const host = syntheticChild(childPrelude + `lines.on('line', ()=>process.exit(7));`)
  try {
    await host.ready()
    await expect(host.control('evidence')).rejects.toMatchObject({
      code: 'HOST_EXIT_BEFORE_CONTROL_REPLY',
    })
  } finally {
    await host.closeOwned()
  }
  await host.closed
})

test('successful proof runs every cleanup and diagnostic output exceptions cannot escape', async () => {
  const steps: string[] = []
  expect(
    await runFactoryProof(
      async () => {
        steps.push('work')
      },
      {
        phase: () => 'prepare',
        readerRequests: () => 0,
        actions: [
          () => {
            steps.push('cleanup')
          },
        ],
      },
      () => {
        throw new Error('unexpected diagnostic')
      }
    )
  ).toBe(0)
  expect(steps).toEqual(['work', 'cleanup'])
  let cleaned = false
  expect(
    await runFactoryProof(
      async () => {
        throw new Error(canary)
      },
      {
        phase: () => 'dispatch',
        readerRequests: () => 0,
        actions: [
          () => {
            cleaned = true
          },
        ],
      },
      () => {
        throw new Error(canary)
      }
    )
  ).toBe(1)
  expect(cleaned).toBe(true)
})
