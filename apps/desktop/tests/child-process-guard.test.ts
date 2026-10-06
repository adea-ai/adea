// Regression guard for the intermittent single-process suite hang: no child a
// test spawns may still be exiting when Bun's file-boundary dangling-process
// sweep runs. The preload settles each test's children; these tests pin the
// wiring and the settle/carry contract.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { liveChildren, reapFileChildren, settleChildren } from './fixtures/child-process-guard'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('desktop suite child-process guard', () => {
  test('is preloaded for every desktop test file', () => {
    const bunfig = readFileSync(join(import.meta.dir, '../bunfig.toml'), 'utf8')
    expect(bunfig).toContain('preload = ["./tests/fixtures/child-process-guard.ts"]')
    expect(
      (Bun.spawn as unknown as Record<symbol, boolean>)[
        Symbol.for('adea.desktop.childProcessGuard')
      ]
    ).toBe(true)
  })

  let fireAndForgetPid = 0
  test('a fire-and-forget child is tracked while it runs', () => {
    // Deliberately never awaited — the shape of the dev-runtime inventory
    // probes that used to finish exactly as their test file ended.
    fireAndForgetPid = Bun.spawn(['/bin/sh', '-c', 'sleep 0.3'], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).pid
    expect(liveChildren().map((child) => child.pid)).toContain(fireAndForgetPid)
  })

  test('the previous test’s child was exited and reaped before this test began', () => {
    expect(fireAndForgetPid).toBeGreaterThan(0)
    expect(liveChildren().map((child) => child.pid)).not.toContain(fireAndForgetPid)
    expect(isAlive(fireAndForgetPid)).toBe(false)
  })

  test('a child outliving the settle window is carried, not killed', async () => {
    const child = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      expect(await settleChildren(100)).toBe(1)
      expect(isAlive(child.pid)).toBe(true)
      expect(liveChildren().find((entry) => entry.pid === child.pid)?.carried).toBe(true)
      // A carried child is skipped by later settles: its owner tears it down.
      expect(await settleChildren(100)).toBe(0)
    } finally {
      child.kill('SIGKILL')
      await child.exited
    }
    expect(liveChildren().map((entry) => entry.pid)).not.toContain(child.pid)
  })

  test('file-end enforcement SIGKILLs, reaps, and names a leaked child', async () => {
    const child = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    const leaked = await reapFileChildren(100)
    expect(leaked).toEqual([
      {
        pid: child.pid,
        argv: '/bin/sleep 30',
        origin: expect.stringContaining('child-process-guard.test.ts'),
      },
    ])
    expect(child.signalCode).toBe('SIGKILL')
    expect(isAlive(child.pid)).toBe(false)
    expect(liveChildren()).toEqual([])
  })

  test('file-end enforcement is clean once every child has exited', async () => {
    Bun.spawn(['/bin/sh', '-c', 'sleep 0.2'], { stdout: 'ignore', stderr: 'ignore' })
    expect(await reapFileChildren(5_000)).toEqual([])
    expect(liveChildren()).toEqual([])
  })
})
