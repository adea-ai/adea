import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  FactoryFixtureFailure,
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
    (record) => records.push(record)
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
      (record) => records.push(record)
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
      (record) => {
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
      async (record) => {
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
