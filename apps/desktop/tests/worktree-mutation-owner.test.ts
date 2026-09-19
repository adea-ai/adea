// Cross-process mutation ownership: real child processes contend for the
// per-repo lock, a killed owner is proven gone and recovered, and the
// idempotency ledger prevents duplicate work across timeout/retry — including
// across processes.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRepoMutationOwner } from '../shell/src/dev-runtime/worktrees/mutation-owner'

const runtimeNodeId = '00000000-0000-4000-8000-000000000003'
const scratchRoots: string[] = []

afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adea-mutation-owner-'))
  scratchRoots.push(dir)
  return dir
}

const CHILD_SCRIPT = `
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRepoMutationOwner } from ${JSON.stringify(new URL('../shell/src/dev-runtime/worktrees/mutation-owner.ts', import.meta.url).pathname)}
const dataDir = process.env.CHILD_DATA_DIR!
const commonDir = process.env.CHILD_COMMON_DIR!
const mode = process.env.CHILD_MODE!
const owner = createRepoMutationOwner({ dataDir, runtimeNodeId: ${JSON.stringify(runtimeNodeId)} })
if (mode === 'hold') {
  const release = await owner.holdLock(commonDir, 'worktree-create', 5000)
  await Bun.write(join(commonDir, 'ready'), '1')
  // Hold until the parent signals or the guard elapses.
  const deadline = Date.now() + 20_000
  while (!existsSync(join(commonDir, 'release')) && Date.now() < deadline) {
    await Bun.sleep(50)
  }
  release()
  process.exit(0)
}
if (mode === 'complete') {
  const result = await owner.withMutation(
    { repoCommonDir: commonDir, operation: 'worktree-create', idempotencyKey: process.env.CHILD_KEY ?? 'key-1' },
    async () => {
      await Bun.write(join(commonDir, 'child-marker'), 'created-once')
      return { created: true, worktreeId: 'wt-child' }
    }
  )
  await Bun.write(join(commonDir, 'child-result'), JSON.stringify(result))
  process.exit(0)
}
process.exit(1)
`

function spawnChild(dir: string, commonDir: string, mode: string, extra?: { key?: string }) {
  return Bun.spawn(['bun', '-e', CHILD_SCRIPT], {
    env: {
      ...process.env,
      CHILD_DATA_DIR: dir,
      CHILD_COMMON_DIR: commonDir,
      CHILD_MODE: mode,
      ...(extra?.key ? { CHILD_KEY: extra.key } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

describe('cross-process repository mutation lock', () => {
  test('a live foreign owner blocks acquisition until lock_timeout', async () => {
    const dir = scratch()
    const commonDir = join(dir, 'repo')
    await Bun.write(join(commonDir, '.keep'), '')
    const child = spawnChild(dir, commonDir, 'hold')
    // Wait for the child to hold the lock.
    const deadline = Date.now() + 15_000
    while (!existsSync(join(commonDir, 'ready')) && Date.now() < deadline) {
      await Bun.sleep(50)
    }
    expect(existsSync(join(commonDir, 'ready'))).toBe(true)

    const owner = createRepoMutationOwner({ dataDir: dir, runtimeNodeId, pollIntervalMs: 20 })
    let timedOut = false
    try {
      await owner.withMutation(
        { repoCommonDir: commonDir, operation: 'worktree-create', timeoutMs: 300 },
        async () => 'x'
      )
    } catch (error) {
      timedOut = (error as { code?: string }).code === 'lock_timeout'
    }
    expect(timedOut).toBe(true)
    expect(owner.lockOwner(commonDir)?.pid).toBe(child.pid)

    writeFileSync(join(commonDir, 'release'), '1')
    await child.exited
    expect(owner.lockFileExists(commonDir)).toBe(false)
  })

  test('recovers a stale lock once the owner process is proven gone', async () => {
    const dir = scratch()
    const commonDir = join(dir, 'repo')
    await Bun.write(join(commonDir, '.keep'), '')
    const child = spawnChild(dir, commonDir, 'hold')
    const deadline = Date.now() + 15_000
    while (!existsSync(join(commonDir, 'ready')) && Date.now() < deadline) {
      await Bun.sleep(50)
    }

    // Kill the owner hard (no release): same-node PID death is proof.
    child.kill('SIGKILL')
    await child.exited

    const owner = createRepoMutationOwner({ dataDir: dir, runtimeNodeId, pollIntervalMs: 20 })
    let acquired = false
    await owner.withMutation(
      { repoCommonDir: commonDir, operation: 'worktree-create', timeoutMs: 10_000 },
      async () => {
        acquired = true
        return 'ok'
      }
    )
    expect(acquired).toBe(true)
  })

  test('a foreign node with no heartbeat for the stale window is stealable', async () => {
    const dir = scratch()
    const commonDir = join(dir, 'repo')
    await Bun.write(join(commonDir, '.keep'), '')
    const holder = createRepoMutationOwner({
      dataDir: dir,
      runtimeNodeId: 'other-node',
      clock: () => new Date(),
    })
    await holder.holdLock(commonDir, 'worktree-create', 1000)

    // A peer on another node whose clock observed 31s without a heartbeat.
    let now = Date.now()
    const stealer = createRepoMutationOwner({
      dataDir: dir,
      runtimeNodeId,
      pollIntervalMs: 20,
      clock: () => new Date((now += 1_000)),
    })
    let acquired = false
    // The fake clock advances 1s per call, so the acquire budget (60s fake)
    // must comfortably exceed the 30s stale-consideration window.
    await stealer.withMutation(
      { repoCommonDir: commonDir, operation: 'worktree-create', timeoutMs: 60_000 },
      async () => {
        acquired = true
        return 'ok'
      }
    )
    expect(acquired).toBe(true)
  })
})

describe('idempotency ledger', () => {
  test('replays the recorded result instead of repeating the side effect', async () => {
    const dir = scratch()
    const commonDir = join(dir, 'repo')
    const owner = createRepoMutationOwner({ dataDir: dir, runtimeNodeId })
    let runs = 0
    const first = await owner.withMutation(
      { repoCommonDir: commonDir, operation: 'worktree-create', idempotencyKey: 'retry-key' },
      async () => {
        runs += 1
        return { id: 'wt-1' }
      }
    )
    const second = await owner.withMutation(
      { repoCommonDir: commonDir, operation: 'worktree-create', idempotencyKey: 'retry-key' },
      async () => {
        runs += 1
        return { id: 'wt-2' }
      }
    )
    expect(runs).toBe(1)
    expect(first).toEqual({ id: 'wt-1' })
    expect(second).toEqual({ id: 'wt-1' })
  })

  test('a completed mutation is deduplicated across real processes', async () => {
    const dir = scratch()
    const commonDir = join(dir, 'repo')
    await Bun.write(join(commonDir, '.keep'), '')
    const child = spawnChild(dir, commonDir, 'complete', { key: 'shared-key' })
    await child.exited
    expect(child.exitCode).toBe(0)
    expect(readFileSync(join(commonDir, 'child-marker'), 'utf8')).toBe('created-once')

    // The parent retries the same logical mutation: no duplicate side effect,
    // the recorded result replays.
    const owner = createRepoMutationOwner({ dataDir: dir, runtimeNodeId })
    let ranLocally = false
    const replayed = await owner.withMutation(
      { repoCommonDir: commonDir, operation: 'worktree-create', idempotencyKey: 'shared-key' },
      async () => {
        ranLocally = true
        return { created: true, worktreeId: 'wt-parent' }
      }
    )
    expect(ranLocally).toBe(false)
    expect(replayed).toEqual({ created: true, worktreeId: 'wt-child' })
  })

  test('rejects malformed idempotency keys', async () => {
    const dir = scratch()
    const owner = createRepoMutationOwner({ dataDir: dir, runtimeNodeId })
    // Spaces are printable ASCII (valid per the limits registry); control
    // characters and over-long keys are not.
    expect(
      owner.withMutation(
        {
          repoCommonDir: join(dir, 'r'),
          operation: 'op',
          idempotencyKey: `bad${String.fromCharCode(1)}key`,
        },
        async () => 'x'
      )
    ).rejects.toMatchObject({ code: 'invalid_state' })
    expect(
      owner.withMutation(
        { repoCommonDir: join(dir, 'r'), operation: 'op', idempotencyKey: 'k'.repeat(129) },
        async () => 'x'
      )
    ).rejects.toMatchObject({ code: 'invalid_state' })
  })
})
