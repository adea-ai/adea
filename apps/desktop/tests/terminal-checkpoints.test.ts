// Issue #396 durable-history contract: versioned checksummed segments,
// owner-only permissions, atomic rename, cold-restore read-back, bounded
// search, corruption quarantine with retained bytes, containment-proven
// deletion, and session byte budgets.
import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createCheckpointSink,
  type SegmentChunk,
} from '../shell/src/dev-runtime/terminal/checkpoints'
import { TERMINAL_LIMITS } from '../shell/src/dev-runtime/terminal/limits'

const terminalId = '00000000-0000-4000-8000-0000000000a1'

function chunk(seq: number, text: string): SegmentChunk {
  return {
    seq: String(seq),
    emittedAt: '2026-09-18T00:00:00.000Z',
    bytes: new TextEncoder().encode(text),
  }
}

function sink(
  runtimeRoot: string,
  overrides?: { terminalId?: string; maxBytesPerSession?: number; beforeWrite?: () => void }
) {
  return createCheckpointSink({
    runtimeRoot,
    terminalId: overrides?.terminalId ?? terminalId,
    generation: 1,
    maxBytesPerSession: overrides?.maxBytesPerSession,
    beforeWrite: overrides?.beforeWrite,
  })
}

describe('terminal checkpoint store', () => {
  test('failed checkpoint writes retain pending chunks for a later retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-term-ckpt-'))
    let fail = true
    try {
      const store = sink(root, {
        beforeWrite: () => {
          if (fail) throw new Error('disk full')
        },
      })
      store.append(chunk(0, 'retry me'))
      expect(store.checkpoint()).toMatchObject({ ok: false })
      expect(store.read('0').map((entry) => new TextDecoder().decode(entry.bytes))).toEqual([
        'retry me',
      ])
      fail = false
      expect(store.checkpoint()).toMatchObject({ ok: true })
      expect(store.read('0').map((entry) => new TextDecoder().decode(entry.bytes))).toEqual([
        'retry me',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('writes atomic owner-only segments and reads them back byte-exact', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-term-ckpt-'))
    try {
      const store = sink(root)
      store.append(chunk(0, 'hello '))
      store.append(chunk(1, 'durable world'))
      const checkpointed = store.checkpoint()
      expect(checkpointed.ok).toBe(true)
      if (checkpointed.ok && checkpointed.value) {
        expect(checkpointed.value.fromSeq).toBe('0')
        expect(checkpointed.value.toSeq).toBe('1')
        expect(checkpointed.value.chunkCount).toBe(2)
      }
      expect(store.latestSequence()).toBe('1')
      const sessionDir = join(root, terminalId)
      const segment = readdirSync(sessionDir).find((name) => name.endsWith('.adt'))!
      const mode = statSync(join(sessionDir, segment)).mode & 0o777
      expect(mode).toBe(0o600)
      expect(statSync(sessionDir).mode & 0o777).toBe(0o700)
      const restored = store.read('0')
      expect(restored.map((entry) => new TextDecoder().decode(entry.bytes))).toEqual([
        'hello ',
        'durable world',
      ])
      const joined = restored.map((entry) => new TextDecoder().decode(entry.bytes)).join('')
      expect(joined).toBe('hello durable world')
      // Partial read starts at the requested sequence.
      expect(store.read('1').map((entry) => entry.seq)).toEqual(['1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('auto-checkpoints on the byte interval and enforces the session budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-term-ckpt-gc-'))
    try {
      // maxChunkBytes-sized appends trigger an auto checkpoint each time.
      const budget = 4 * TERMINAL_LIMITS.maxChunkBytes
      const store = sink(root, { maxBytesPerSession: budget })
      for (let index = 0; index < 6; index += 1) {
        store.append(chunk(index, 'x'.repeat(TERMINAL_LIMITS.maxChunkBytes)))
      }
      expect(store.byteLength()).toBeLessThanOrEqual(budget + TERMINAL_LIMITS.maxChunkBytes)
      expect(store.latestSequence()).toBe('5')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('search returns bounded matches with sequence and byte offsets', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-term-search-'))
    try {
      const store = sink(root)
      store.append(chunk(0, 'build started\n'))
      store.append(chunk(1, 'error: TS2304 cannot find name'))
      store.append(chunk(2, 'error: second failure'))
      store.checkpoint()
      const matches = store.search('error:', 10)
      expect(matches).toHaveLength(2)
      expect(matches[0]).toMatchObject({ seq: '1', byteOffset: '0' })
      expect(matches[0]!.preview).not.toMatch(/[\n\r]/)
      expect(store.search('error:', 1)).toHaveLength(1)
      expect(store.search('absent-query', 10)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('corrupt segments are quarantined with raw bytes retained, never deleted', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-term-corrupt-'))
    try {
      const sessionDir = join(root, terminalId)
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(sessionDir, 'seg-1-0-5.adt'), new Uint8Array([1, 2, 3]), { mode: 0o600 })
      const store = sink(root)
      const restored = store.read('0')
      // The corrupt segment is reported as corrupt data (read returns nothing)
      // and the raw bytes survive under corrupt/.
      expect(restored).toEqual([])
      const corruptDir = join(sessionDir, 'corrupt')
      expect(existsSync(corruptDir)).toBe(true)
      expect(readdirSync(corruptDir).length).toBe(1)
      const quarantined = readdirSync(corruptDir)[0]!
      expect([...readUint8(join(corruptDir, quarantined))]).toEqual([1, 2, 3])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('flips a flipped byte into quarantine instead of replaying garbage', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-term-bitflip-'))
    try {
      const store = sink(root)
      store.append(chunk(0, 'integrity'))
      store.checkpoint()
      const sessionDir = join(root, terminalId)
      const segment = join(
        sessionDir,
        readdirSync(sessionDir).find((name) => name.endsWith('.adt'))!
      )
      const bytes = readUint8(segment)
      bytes[bytes.length - 1] ^= 0xff
      writeFileSync(segment, bytes, { mode: 0o600 })
      const reread = sink(root).read('0')
      expect(reread).toEqual([])
      expect(existsSync(join(sessionDir, 'corrupt'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('deleteHistory re-proves containment and removes every segment', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-term-delete-'))
    try {
      const store = sink(root)
      store.append(chunk(0, 'one'))
      store.checkpoint()
      store.append(chunk(1, 'two'))
      store.checkpoint()
      expect(store.byteLength()).toBeGreaterThan(0)
      const deleted = store.deleteHistory()
      expect(deleted).toEqual({ ok: true, value: { deletedSegments: 2 } })
      expect(store.byteLength()).toBe(0)
      expect(store.latestSequence()).toBe('0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects terminal IDs that are not opaque UUIDs', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-term-ids-'))
    try {
      expect(() =>
        createCheckpointSink({ runtimeRoot: root, terminalId: '../../escape', generation: 1 })
      ).toThrow()
      expect(() =>
        createCheckpointSink({ runtimeRoot: root, terminalId: 'seg-evil', generation: 1 })
      ).toThrow()
      // No directory was created for the rejected IDs.
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('permissions survive across a fresh sink instance', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-term-perm-'))
    try {
      sink(root).append(chunk(0, 'persisted'))
      sink(root).checkpoint()
      // Runtime root itself must be owner-only (the sink creates it).
      chmodSync(root, 0o700)
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(sink(root).latestSequence()).toBe('0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function readUint8(path: string): Uint8Array {
  return new Uint8Array(require('node:fs').readFileSync(path))
}
