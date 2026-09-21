// Checkpoint retention (#396/#399 residues): the per-session and per-scope
// caps are enforced at durable-write time with the replay contract intact —
// eviction is oldest-first, the surviving sealed chain stays contiguous from
// its oldest segment forward, a live replay floor is never evicted, deletion
// is atomic per segment (rename-then-unlink, tombstones swept, quarantine
// bytes untouched), scope GC goes oldest eligible session first, and GC
// under sustained concurrent writes keeps the chain provably contiguous.
// Attach below the surviving window resyncs deterministically (the
// `durableBridge` null on every retry), never replays partially.
import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHECKPOINT_RETENTION,
  enforceScopeRetention,
  evictOldestSealedSegments,
  listSealedSegments,
  sweepTombstones,
} from '../shell/src/dev-runtime/terminal/retention'
import {
  createCheckpointSink,
  type SegmentChunk,
} from '../shell/src/dev-runtime/terminal/checkpoints'
import { durableBridge } from '../shell/src/dev-runtime/terminal/sidecar/service'

const TERMINAL_A = '00000000-0000-4000-8000-0000000000a1'
const TERMINAL_B = '00000000-0000-4000-8000-0000000000b2'
const TERMINAL_C = '00000000-0000-4000-8000-0000000000c3'

function chunk(seq: number, text: string): SegmentChunk {
  return {
    seq: String(seq),
    emittedAt: '2026-09-21T00:00:00.000Z',
    bytes: new TextEncoder().encode(text),
  }
}

type SinkOverrides = {
  terminalId?: string
  maxBytesPerSession?: number
  maxSegmentsPerSession?: number
  scopeRetention?: { maxBytes?: number; isProtected?: (terminalId: string) => boolean }
}

function sink(root: string, overrides?: SinkOverrides) {
  return createCheckpointSink({
    runtimeRoot: root,
    terminalId: overrides?.terminalId ?? TERMINAL_A,
    generation: 1,
    ...(overrides?.maxBytesPerSession !== undefined
      ? { maxBytesPerSession: overrides.maxBytesPerSession }
      : {}),
    ...(overrides?.maxSegmentsPerSession !== undefined
      ? { maxSegmentsPerSession: overrides.maxSegmentsPerSession }
      : {}),
    ...(overrides?.scopeRetention ? { scopeRetention: overrides.scopeRetention } : {}),
  })
}

/** Seals one segment per chunk so tests control segment granularity. */
function seal(store: ReturnType<typeof sink>, startSeq: number, texts: readonly string[]): void {
  for (const [offset, text] of texts.entries()) {
    store.append(chunk(startSeq + offset, text))
    expect(store.checkpoint()).toMatchObject({ ok: true })
  }
}

/** The replay-integrity invariant: every surviving chunk is byte-exact and
 *  strictly consecutive from the oldest surviving sequence forward. */
function expectContiguous(
  store: ReturnType<typeof sink>,
  expectedTexts: Readonly<Record<number, string>>
): void {
  const all = store.read('0')
  expect(all.length).toBeGreaterThan(0)
  let previous: bigint | undefined
  for (const entry of all) {
    const seq = BigInt(entry.seq)
    if (previous !== undefined) expect(seq).toBe(previous + 1n)
    previous = seq
    expect(new TextDecoder().decode(entry.bytes)).toBe(expectedTexts[Number(seq)])
  }
}

/** A scope pass may lawfully evict a session whole. A truthful empty store
 *  rebuilds from one fresh seal; then the invariant must hold. */
function ensureRebuiltContiguous(
  store: ReturnType<typeof sink>,
  expectedTexts: Record<number, string>,
  nextSeq: number,
  text: string
): void {
  if (store.read('0').length === 0) {
    expectedTexts[nextSeq] = text
    seal(store, nextSeq, [text])
  }
  expectContiguous(store, expectedTexts)
}

describe('checkpoint retention constants', () => {
  test('caps are the named spec limits and exported for tests', () => {
    expect(CHECKPOINT_RETENTION.maxBytesPerSession).toBe(256 * 1024 * 1024)
    expect(CHECKPOINT_RETENTION.maxBytesPerScope).toBe(2 * 1024 ** 3)
    expect(CHECKPOINT_RETENTION.maxSegmentsPerSession).toBe(4096)
  })
})

describe('per-session retention', () => {
  test('prunes oldest sealed segments beyond the byte cap; surviving chain stays contiguous', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retention-boundary-'))
    try {
      // One chunk per segment; each sealed segment carries name/footer
      // overhead, so the byte cap (not the count cap) drives eviction.
      const chunkBytes = 512
      const budget = 3 * (chunkBytes + 256)
      const store = sink(root, { maxBytesPerSession: budget })
      const texts: Record<number, string> = {}
      for (let seq = 0; seq < 8; seq += 1) {
        const text = `seg-${seq}-`.padEnd(chunkBytes, 'x')
        texts[seq] = text
        seal(store, seq, [text])
      }
      expect(store.byteLength()).toBeLessThanOrEqual(budget + 2 * (chunkBytes + 512))
      // Replay integrity: what survives is byte-exact and consecutive from
      // its oldest surviving segment forward, and the pruned prefix is
      // really gone (disk accounting matches the sink's).
      expectContiguous(store, texts)
      expect(store.byteLength()).toBe(
        listSealedSegments(join(root, TERMINAL_A)).reduce(
          (total, segment) => total + segment.size,
          0
        )
      )
      expect(store.latestSequence()).toBe('7')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('attach below the pruned window resyncs deterministically instead of partial replay', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retention-resync-'))
    try {
      const store = sink(root, { maxBytesPerSession: 3 * 768 })
      const texts: Record<number, string> = {}
      for (let seq = 0; seq < 8; seq += 1) {
        const text = `segment-${seq}`.padEnd(512, '.')
        texts[seq] = text
        seal(store, seq, [text])
      }
      const surviving = store.read('0')
      const oldestSurviving = BigInt(surviving[0]!.seq)
      expect(oldestSurviving).toBeGreaterThan(0n)
      // A ring that starts at the newest sequence: everything durable is
      // "below the ring", the exact packaged-replay shape. Below the
      // surviving window no bridge is possible — the reply is the
      // deterministic resync anchor, and it is the SAME null on every retry
      // (never a partial prefix pretending to be continuous).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(durableBridge(store, '0', '7')).toBeNull()
      }
      // At the surviving window: the bridge replays the exact contiguous
      // span to the ring anchor, exactly once, in order, byte-exact across
      // the GC boundary.
      const bridge = durableBridge(store, String(oldestSurviving), '7')
      expect(bridge).not.toBeNull()
      const bridgeSeqs = bridge!.chunks.map((entry) => BigInt(entry.seq))
      expect(bridgeSeqs[0]).toBe(oldestSurviving)
      for (let index = 1; index < bridgeSeqs.length; index += 1) {
        expect(bridgeSeqs[index]).toBe(bridgeSeqs[index - 1]! + 1n)
      }
      for (const entry of bridge!.chunks) {
        expect(new TextDecoder().decode(entry.bytes)).toBe(texts[Number(entry.seq)])
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live replay floor pins its segment: writes prune past it only after release', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retention-floor-'))
    try {
      const store = sink(root, { maxBytesPerSession: 2 * 768 })
      const texts: Record<number, string> = {}
      for (let seq = 0; seq < 3; seq += 1) {
        const text = `segment-${seq}`
        texts[seq] = text
        seal(store, seq, [text])
      }
      // A subscriber attaches mid-bridge from chunk 1 BEFORE further writes:
      // the segment covering it must survive every subsequent write-time
      // pass even though the cap keeps demanding eviction.
      const release = store.protectFrom('1')
      for (let seq = 3; seq < 9; seq += 1) {
        const text = `segment-${seq}`
        texts[seq] = text
        seal(store, seq, [text])
      }
      // The floor segment is still there: replay starts exactly at it and
      // the chain runs contiguous through the newest byte.
      expect(store.read('1').map((entry) => entry.seq)[0]).toBe('1')
      expectContiguous(store, texts)
      // Release; the next write-time pass prunes oldest-first again and the
      // chain stays contiguous from its new oldest survivor forward.
      release()
      texts[9] = 'segment-9'
      seal(store, 9, ['segment-9'])
      const surviving = store.read('0')
      expect(BigInt(surviving[0]!.seq)).toBeGreaterThan(1n)
      expectContiguous(store, texts)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the sealed-segment count cap bounds tiny-segment accumulation', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retention-count-'))
    try {
      // A byte cap that can never bind: only the count cap can evict.
      const store = sink(root, {
        maxBytesPerSession: 1024 * 1024,
        maxSegmentsPerSession: 4,
      })
      const texts: Record<number, string> = {}
      for (let seq = 0; seq < 12; seq += 1) {
        const text = `t${seq}`
        texts[seq] = text
        seal(store, seq, [text])
      }
      expect(listSealedSegments(join(root, TERMINAL_A)).length).toBeLessThanOrEqual(4)
      expectContiguous(store, texts)
      expect(store.latestSequence()).toBe('11')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('deletion is atomic per segment: tombstones are swept and quarantine bytes are untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retention-tombstone-'))
    try {
      const sessionDir = join(root, TERMINAL_A)
      const store = sink(root, { maxBytesPerSession: 2 * 768 })
      for (let seq = 0; seq < 6; seq += 1) seal(store, seq, [`segment-${seq}`])
      // A crash between rename and unlink left a tombstone behind.
      writeFileSync(join(sessionDir, '.gc-stale.adt'), new Uint8Array([9]), { mode: 0o600 })
      expect(sweepTombstones(sessionDir)).toBe(1)
      expect(existsSync(join(sessionDir, '.gc-stale.adt'))).toBe(false)
      // Quarantined raw bytes survive every retention pass.
      const corruptDir = join(sessionDir, 'corrupt')
      mkdirSync(corruptDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(corruptDir, 'evidence.adt'), new Uint8Array([1, 2, 3]), { mode: 0o600 })
      seal(store, 6, ['segment-6'])
      seal(store, 7, ['segment-7'])
      expect(existsSync(join(corruptDir, 'evidence.adt'))).toBe(true)
      expect(readdirSync(sessionDir).some((name) => name.startsWith('.gc-'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a segment that fails its containment re-proof stops the pass (fail closed)', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retention-failclosed-'))
    try {
      const sessionDir = join(root, TERMINAL_A)
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
      // Hand-laid sealed names (never read, only named): the FIRST one the
      // pass would delete carries a stale path that escapes containment.
      for (let index = 0; index < 3; index += 1) {
        writeFileSync(join(sessionDir, `seg-1-${index}-${index}.adt`), new Uint8Array([1]), {
          mode: 0o600,
        })
      }
      const segments = listSealedSegments(sessionDir)
      const escapee = { ...segments[0]!, path: join(root, 'seg-1-0-0.adt') }
      const result = evictOldestSealedSegments({
        sessionDir,
        segments: [escapee, ...segments.slice(1)],
        maxBytes: 0,
        maxSegments: 1,
      })
      // The refused delete ends the pass: nothing is pruned past the broken
      // boundary and every listed segment survives on disk.
      expect(result.remaining.length).toBe(3)
      for (const segment of segments) {
        expect(existsSync(join(sessionDir, segment.name))).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('per-scope retention', () => {
  test('evicts the oldest eligible session whole; the active session is protected', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retention-scope-'))
    try {
      for (const terminalId of [TERMINAL_A, TERMINAL_B, TERMINAL_C]) {
        const dir = join(root, terminalId)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        // 3 sealed segments of 100 bytes each per session.
        for (let index = 0; index < 3; index += 1) {
          writeFileSync(
            join(dir, `seg-1-${index * 10}-${index * 10 + 9}.adt`),
            new Uint8Array(100),
            {
              mode: 0o600,
            }
          )
        }
      }
      // Deterministic ages: A oldest, then B, then C.
      utimesSync(join(root, TERMINAL_A, 'seg-1-0-9.adt'), new Date(1_000), new Date(1_000))
      utimesSync(join(root, TERMINAL_B, 'seg-1-0-9.adt'), new Date(2_000), new Date(2_000))
      utimesSync(join(root, TERMINAL_C, 'seg-1-0-9.adt'), new Date(3_000), new Date(3_000))

      // Budget for two sessions: the oldest eligible (A) goes whole.
      const first = enforceScopeRetention({
        runtimeRoot: root,
        activeTerminalId: TERMINAL_C,
        maxBytes: 600,
      })
      expect(first.evictedSessions).toEqual([TERMINAL_A])
      expect(existsSync(join(root, TERMINAL_A, 'seg-1-0-9.adt'))).toBe(false)

      // A write on C re-enforces with C protected under a one-session
      // budget: the next oldest (B) goes whole.
      const second = enforceScopeRetention({
        runtimeRoot: root,
        activeTerminalId: TERMINAL_C,
        maxBytes: 300,
      })
      expect(second.evictedSessions).toEqual([TERMINAL_B])

      // Only the protected active session remains: over budget, but a fully
      // protected scope stays truthfully over its cap and keeps its data.
      const third = enforceScopeRetention({
        runtimeRoot: root,
        activeTerminalId: TERMINAL_C,
        maxBytes: 0,
      })
      expect(third.evictedSessions).toEqual([])
      expect(third.remainingBytes).toBe(300)
      expect(listSealedSegments(join(root, TERMINAL_C)).length).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a session holding a live replay-floor reservation is scope-protected', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retention-scope-floor-'))
    try {
      for (const terminalId of [TERMINAL_A, TERMINAL_B]) {
        const dir = join(root, terminalId)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        for (let index = 0; index < 2; index += 1) {
          writeFileSync(
            join(dir, `seg-1-${index * 10}-${index * 10 + 9}.adt`),
            new Uint8Array(100),
            {
              mode: 0o600,
            }
          )
        }
      }
      utimesSync(join(root, TERMINAL_A, 'seg-1-0-9.adt'), new Date(1_000), new Date(1_000))
      utimesSync(join(root, TERMINAL_B, 'seg-1-0-9.adt'), new Date(2_000), new Date(2_000))
      // A is oldest, B holds a live bridge reservation: nothing is eligible,
      // and the scope stays over its cap rather than breaking B's window.
      const result = enforceScopeRetention({
        runtimeRoot: root,
        activeTerminalId: TERMINAL_A,
        maxBytes: 300,
        isProtected: (terminalId) => terminalId === TERMINAL_B,
      })
      expect(result.evictedSessions).toEqual([])
      expect(result.remainingBytes).toBe(400)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('retention under concurrent writes', () => {
  test('interleaved sessions writing through one scope keep every chain contiguous', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retention-concurrent-'))
    try {
      const scopeCap = 6 * 768
      const storeA = sink(root, {
        terminalId: TERMINAL_A,
        maxBytesPerSession: 4 * 768,
        scopeRetention: { maxBytes: scopeCap },
      })
      const storeB = sink(root, {
        terminalId: TERMINAL_B,
        maxBytesPerSession: 4 * 768,
        scopeRetention: { maxBytes: scopeCap },
      })
      const textsA: Record<number, string> = {}
      const textsB: Record<number, string> = {}
      // Interleave: A and B seal alternately, both write-time passes
      // evicting under the same scope budget — the concurrent-write shape.
      for (let round = 0; round < 10; round += 1) {
        const textA = `a-${round}`.padEnd(512, '.')
        textsA[round] = textA
        seal(storeA, round, [textA])
        const textB = `b-${round}`.padEnd(512, '.')
        textsB[round] = textB
        seal(storeB, round, [textB])
      }
      // Post-burst integrity: a whole-session scope eviction is truthful —
      // the store may legitimately be empty. Either way, one fresh seal
      // (small enough never to evict the sibling) leaves a chain that is
      // provably byte-exact and contiguous from its oldest survivor.
      ensureRebuiltContiguous(storeA, textsA, 10, 'a-rebuilt'.padEnd(512, '.'))
      ensureRebuiltContiguous(storeB, textsB, 10, 'b-rebuilt'.padEnd(512, '.'))
      expectContiguous(storeA, textsA)
      expectContiguous(storeB, textsB)
      // Disk accounting stays truthful: the sink's bytes are the files'.
      expect(storeA.byteLength()).toBe(
        listSealedSegments(join(root, TERMINAL_A)).reduce(
          (total, segment) => total + segment.size,
          0
        )
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a mid-bridge floor survives another session write-time scope pass until release', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retention-concurrent-floor-'))
    try {
      // The shared protection seam the sidecar wires: ref-counted live
      // replay windows per terminal.
      const floors = new Map<string, number>()
      const isProtected = (terminalId: string): boolean => (floors.get(terminalId) ?? 0) > 0
      const scopeRetention = { maxBytes: 3 * 768, isProtected }
      const storeA = sink(root, {
        terminalId: TERMINAL_A,
        maxBytesPerSession: 1024 * 1024,
        scopeRetention,
      })
      const storeB = sink(root, {
        terminalId: TERMINAL_B,
        maxBytesPerSession: 1024 * 1024,
        scopeRetention,
      })
      const textsB: Record<number, string> = {}
      for (let seq = 0; seq < 5; seq += 1) {
        const text = `b-${seq}`
        textsB[seq] = text
        seal(storeB, seq, [text])
      }
      utimesSync(join(root, TERMINAL_B, 'seg-1-0-0.adt'), new Date(1_000), new Date(1_000))
      // B's subscriber attaches below its ring: a live floor on chunk 1,
      // registered both in B's sink and the shared scope seam.
      floors.set(TERMINAL_B, 1)
      const releaseSinkFloor = storeB.protectFrom('1')
      // A's writes trigger scope passes: B is floor-protected, and the
      // writing session (A) is protected as active, so the over-budget
      // scope keeps B's history — truthfully, instead of breaking a window.
      for (let seq = 0; seq < 4; seq += 1) {
        seal(storeA, seq, [`a-${seq}`.padEnd(512, '.')])
      }
      const window = storeB.read('1')
      expect(window.map((entry) => entry.seq)).toEqual(['1', '2', '3', '4'])
      for (const entry of window) {
        expect(new TextDecoder().decode(entry.bytes)).toBe(textsB[Number(entry.seq)])
      }
      // Released: B becomes the oldest eligible session, and A's next
      // write-time pass evicts it whole. B's survivors form an empty set —
      // an attach below the ring now resyncs deterministically, the same
      // null on every retry, never a partial replay.
      floors.delete(TERMINAL_B)
      releaseSinkFloor()
      seal(storeA, 4, ['a-4'.padEnd(512, '.')])
      expect(listSealedSegments(join(root, TERMINAL_B))).toEqual([])
      expect(storeB.read('0')).toEqual([])
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(durableBridge(storeB, '0', '5')).toBeNull()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
