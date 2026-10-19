import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function sessionId(index: number): string {
  return `00000000-0000-4000-8000-${(index + 256).toString(16).padStart(12, '0')}`
}

test('continues SQLite pagination after the seeding Bun process exits', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-pagination-child-restart-'))
  const fixture = fileURLToPath(
    new URL('./fixtures/project-session-pagination-child.ts', import.meta.url)
  )
  try {
    function runChild(mode: 'seed' | 'continue'): unknown {
      const result = spawnSync(process.execPath, [fixture, mode, dataDir], {
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 1_048_576,
      })
      // spawnSync returns after child exit. The second invocation cannot share
      // the first child's module state, authority instance or SQLite handles.
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      return JSON.parse(result.stdout)
    }

    const seeded = runChild('seed') as { mode: string; pid: number; count: number }
    expect(seeded.mode).toBe('seed')
    expect(seeded.pid).not.toBe(process.pid)
    expect(seeded.count).toBe(500)

    const reopened = runChild('continue') as {
      mode: string
      pid: number
      ids: string[]
      finalCount: number
      hasContinuation: boolean
      archivedIds: string[]
      archivedHasContinuation: boolean
    }
    expect(reopened.mode).toBe('continue')
    expect(reopened.pid).not.toBe(process.pid)
    // Do not require distinct child PIDs: an OS may reuse a PID after exit.
    expect(reopened.ids).toEqual(Array.from({ length: 620 }, (_, index) => sessionId(index)))
    expect(new Set(reopened.ids).size).toBe(620)
    expect(reopened.finalCount).toBe(120)
    expect(reopened.hasContinuation).toBe(false)
    expect(reopened.archivedIds).toEqual(
      Array.from({ length: 13 }, (_, index) => sessionId(index + 620))
    )
    expect(reopened.archivedHasContinuation).toBe(false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}, 180_000)
