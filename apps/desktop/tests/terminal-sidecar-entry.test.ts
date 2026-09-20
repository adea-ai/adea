// Real-process tests for the terminal sidecar entry's boot-time ownership
// guard and shutdown belt (issue #396 hardening). The guard supersedes a
// leaked predecessor on the same data dir — verified live by executable
// identity plus a `ps` start-identity recheck before any signal, the same
// proof the M10 supervisor uses — and unlinks stale (dead/recycled/replaced)
// endpoint records without signalling anything. The shutdown belt force-exits
// a signalled entry whose graceful path stalls, so a leaked orphan can never
// outlive its replacement. Gate and budget conventions follow the packaged
// macOS smokes (terminal-pty-smoke, supervision-packaged-smoke).
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { endpointFilePath } from '../shell/src/dev-runtime/terminal/sidecar/endpoint-file'

const ENTRY = join(import.meta.dir, '../shell/src/dev-runtime/terminal/sidecar/entry.ts')
const IDENTITY = 'adea-terminal-sidecar@entry-guard-test'

type Endpoint = { pid: number; executableIdentity: string; pidStartIdentity: string }

function readEndpoint(dataDir: string): Endpoint | null {
  try {
    return JSON.parse(readFileSync(endpointFilePath(dataDir), 'utf8')) as Endpoint
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitEndpoint(dataDir: string, budgetMs: number): Promise<Endpoint | null> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const endpoint = readEndpoint(dataDir)
    if (endpoint) return endpoint
    if (Date.now() >= deadline) return null
    await Bun.sleep(50)
  }
}

function boot(dataDir: string): Bun.Subprocess {
  return Bun.spawn(['bun', 'run', ENTRY, '--data-dir', dataDir], {
    env: {
      ...process.env,
      ADEA_SIDECAR_VERSION: 'entry-guard-test',
      ADEA_SIDECAR_IDENTITY: IDENTITY,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
}

async function stop(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  const exited = await Promise.race([
    child.exited.then(
      () => true,
      () => false
    ),
    Bun.sleep(3_000).then(() => false),
  ])
  if (exited) return
  child.kill('SIGKILL')
  await Promise.race([child.exited, Bun.sleep(1_000)])
}

describe.skipIf(process.platform !== 'darwin')('terminal sidecar entry guard', () => {
  const dirs: string[] = []

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'adea-sidecar-entry-'))
    dirs.push(dir)
    return dir
  }

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  test('a boot on a live same-identity data dir supersedes the previous owner cleanly', async () => {
    const dataDir = freshDir()
    const first = boot(dataDir)
    try {
      const before = await waitEndpoint(dataDir, 10_000)
      expect(before).not.toBeNull()
      const firstPid = before?.pid

      const second = boot(dataDir)
      try {
        // The replacement owns the endpoint record only once the old owner
        // is gone and its stale record was cleared.
        let after: Endpoint | null = null
        const deadline = Date.now() + 15_000
        while (!after && Date.now() < deadline) {
          const current = readEndpoint(dataDir)
          if (current && current.pid !== firstPid) after = current
          else await Bun.sleep(50)
        }
        expect(after).not.toBeNull()
        expect(after?.executableIdentity).toBe(IDENTITY)
        expect(isAlive(after?.pid ?? -1)).toBe(true)

        const firstGone = await Promise.race([
          first.exited.then(
            () => true,
            () => false
          ),
          Bun.sleep(8_000).then(() => false),
        ])
        expect(firstGone).toBe(true)
      } finally {
        await stop(second)
      }
    } finally {
      await stop(first)
    }
  }, 45_000)

  test('a stale endpoint from a killed sidecar never blocks the next boot', async () => {
    const dataDir = freshDir()
    const killed = boot(dataDir)
    const stale = await waitEndpoint(dataDir, 10_000)
    expect(stale).not.toBeNull()
    const stalePid = stale?.pid
    killed.kill('SIGKILL')
    await Promise.race([killed.exited, Bun.sleep(3_000)])

    const next = boot(dataDir)
    try {
      let fresh: Endpoint | null = null
      const deadline = Date.now() + 10_000
      while (!fresh && Date.now() < deadline) {
        const current = readEndpoint(dataDir)
        if (current && current.pid !== stalePid) fresh = current
        else await Bun.sleep(50)
      }
      expect(fresh).not.toBeNull()
      expect(isAlive(fresh?.pid ?? -1)).toBe(true)
    } finally {
      await stop(next)
    }
  }, 45_000)

  test('SIGTERM shuts the entry down inside the bounded grace window', async () => {
    const dataDir = freshDir()
    const child = boot(dataDir)
    expect(await waitEndpoint(dataDir, 10_000)).not.toBeNull()
    child.kill()
    const exited = await Promise.race([
      child.exited.then(
        () => true,
        () => false
      ),
      Bun.sleep(6_000).then(() => false),
    ])
    expect(exited).toBe(true)
  }, 30_000)

  test('a sidecar whose endpoint file disappears under it exits cleanly (orphan belt)', async () => {
    const dataDir = freshDir()
    const child = boot(dataDir)
    expect(await waitEndpoint(dataDir, 10_000)).not.toBeNull()
    // The unrecoverable case: the data dir (and with it the only adoption
    // handle) is removed under the live process.
    rmSync(dataDir, { recursive: true, force: true })
    const exited = await Promise.race([
      child.exited.then(
        () => true,
        () => false
      ),
      Bun.sleep(10_000).then(() => false),
    ])
    expect(exited).toBe(true)
  }, 30_000)
})
