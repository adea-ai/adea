// Checkpoint retention (issues #396/#399 residues): the explicit GC policy
// that bounds durable terminal history per session and per scope.
//
// The store in `checkpoints.ts` writes checksummed, content-partitioned
// segments; this module is the only code that removes them outside an
// explicit `deleteHistory`. The contract it implements is the spec's replay
// guarantee (docs/specs/dev-runtime.md, "Output and replay"): sealed segments
// partition a contiguous sequence range, so eviction happens strictly from
// the oldest end and the surviving chain stays contiguous from its oldest
// surviving segment forward. A span that retention pruned never replays
// partially — the attach path resyncs deterministically from live coverage.
//
// Caps are the spec's consolidated limits: 256 MiB per session and 2 GiB per
// workspace ("oldest eligible session first after retention protection"),
// plus a sealed-segment count bound per session (this delta's M12 initial
// default) because the byte cap alone cannot see degenerate tiny-segment
// accumulation. Deletion is atomic per segment: rename to a same-directory
// tombstone (the store's atomic-rename pattern), then unlink — a crash
// between the two leaves a `.gc-` tombstone that a later pass sweeps, never
// a half-visible segment. Quarantined bytes under `corrupt/` are never
// touched: corruption recovery keeps its raw evidence.
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { TERMINAL_LIMITS } from './limits'

/** The retention caps, named for tests and ops (spec: "Consolidated limits
 *  registry"; the segment count is this delta's M12 initial default). */
export const CHECKPOINT_RETENTION = {
  /** Durable terminal data per session (spec: "Output and replay"). */
  maxBytesPerSession: TERMINAL_LIMITS.durableMaxBytesPerSession,
  /** Durable terminal data per workspace/scope; eviction is whole-oldest-
   *  session first after retention protection (spec: "Output and replay"). */
  maxBytesPerScope: TERMINAL_LIMITS.durableMaxBytesPerWorkspace,
  /** Sealed segments per session. The 1 MiB checkpoint interval yields ~256
   *  segments at the byte cap; this bounds explicit-checkpoint bursts that
   *  would otherwise accumulate thousands of tiny files under the same
   *  budget. Tightening is allowed; relaxing requires a spec change. */
  maxSegmentsPerSession: 4096,
} as const

export type SealedSegment = Readonly<{
  /** Absolute path; deletion re-proves containment before every rename. */
  path: string
  name: string
  fromSeq: bigint
  toSeq: bigint
  size: number
  modifiedMs: number
}>

const SEGMENT_NAME = /^seg-\d+-\d+-\d+\.adt$/
const TOMBSTONE_PREFIX = '.gc-'
const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Lists one session's sealed segments, oldest sequence first. Unknown names
 *  (tombstones, temp files, the quarantine directory) are not segments and
 *  are never listed, so a torn deletion can never re-enter the replay set. */
export function listSealedSegments(sessionDir: string): SealedSegment[] {
  if (!existsSync(sessionDir)) return []
  const segments: SealedSegment[] = []
  let names: string[]
  try {
    names = readdirSync(sessionDir)
  } catch {
    return []
  }
  for (const name of names) {
    if (!SEGMENT_NAME.test(name)) continue
    const path = join(sessionDir, name)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      const parts = name.split('-')
      segments.push({
        path,
        name,
        fromSeq: BigInt(parts[2]!),
        toSeq: BigInt(parts[3]!.split('.')[0]!),
        size: stat.size,
        modifiedMs: stat.mtimeMs,
      })
    } catch {
      /* raced deletion; skipped */
    }
  }
  return segments.toSorted((left, right) => (left.fromSeq < right.fromSeq ? -1 : 1))
}

function totalBytes(segments: readonly SealedSegment[]): number {
  return segments.reduce((total, segment) => total + segment.size, 0)
}

/**
 * Removes one segment atomically: re-prove containment, rename to a
 * same-directory tombstone, then unlink. The rename is the commit point —
 * from that instant the segment is out of the sealed set (the name no longer
 * matches `seg-*.adt`), so replay can never observe a half-deleted file.
 * Returns false when the segment could not be removed (containment failed,
 * rename raced): the caller stops instead of pressing past a broken delete.
 */
function removeSegmentAtomically(sessionDir: string, segment: SealedSegment): boolean {
  // Containment is re-proved at call time (the store's delete contract):
  // the path must still resolve directly beneath this session directory.
  if (!segment.path.startsWith(sessionDir + '/')) return false
  const tombstone = join(sessionDir, `${TOMBSTONE_PREFIX}${randomUUID()}`)
  try {
    renameSync(segment.path, tombstone)
  } catch {
    return false
  }
  try {
    unlinkSync(tombstone)
  } catch {
    /* the tombstone is invisible to replay; a later sweep retries */
  }
  return true
}

/** Best-effort sweep of tombstones a crash left between rename and unlink. */
export function sweepTombstones(sessionDir: string): number {
  if (!existsSync(sessionDir)) return 0
  let swept = 0
  try {
    for (const name of readdirSync(sessionDir)) {
      if (!name.startsWith(TOMBSTONE_PREFIX)) continue
      try {
        unlinkSync(join(sessionDir, name))
        swept += 1
      } catch {
        /* keep sweeping */
      }
    }
  } catch {
    /* unreadable directory has nothing to sweep */
  }
  return swept
}

export type SessionEvictionResult = Readonly<{
  evictedSegments: number
  bytesFreed: number
  /** Segments still sealed after the pass, oldest first. */
  remaining: SealedSegment[]
}>

/**
 * One per-session retention pass over an already-listed segment set.
 *
 * Eviction is strictly oldest-first and stops at the first refusal, so the
 * sealed chain stays contiguous from its oldest surviving segment forward:
 * - `protectedFromSeq`: a live replay window floor, or undefined when no
 *   reservation is held. A segment whose `toSeq >= floor` covers the floor
 *   and is never evicted (the window's bridge must stay intact); a present
 *   floor of `0n` legally pins chunk 0's segment.
 * - The newest surviving sealed segment is never evicted: a session keeps
 *   its newest durable anchor, matching the store's prior keep-one rule.
 * - Caps that are already satisfied evict nothing.
 *
 * A protected or failed delete stops the pass with the budget still exceeded
 * — truthful, never a delete past a broken or protected boundary.
 */
export function evictOldestSealedSegments(options: {
  sessionDir: string
  segments: readonly SealedSegment[]
  maxBytes: number
  maxSegments: number
  /** Undefined means no reservation is held; a present floor (including
   *  `0n` — chunk 0 is a legal window) protects its covering segment. */
  protectedFromSeq?: bigint
}): SessionEvictionResult {
  const { sessionDir } = options
  const floor = options.protectedFromSeq
  let segments = [...options.segments]
  sweepTombstones(sessionDir)
  let evictedSegments = 0
  let bytesFreed = 0
  while (segments.length > 1) {
    const bytes = totalBytes(segments)
    if (bytes <= options.maxBytes && segments.length <= options.maxSegments) break
    const oldest = segments[0]!
    // A segment whose toSeq >= floor covers the protected replay window and
    // every later segment is newer, so the pass stops here: eviction is
    // oldest-first or nothing.
    if (floor !== undefined && oldest.toSeq >= floor) break
    if (!removeSegmentAtomically(sessionDir, oldest)) break
    evictedSegments += 1
    bytesFreed += oldest.size
    segments = segments.slice(1)
  }
  return { evictedSegments, bytesFreed, remaining: segments }
}

export type ScopeEvictionResult = Readonly<{
  evictedSessions: string[]
  bytesFreed: number
  /** Total sealed bytes still retained across the scope after the pass. */
  remainingBytes: number
}>

/**
 * One per-scope retention pass over every terminal session directory beneath
 * the runtime root (spec: 2 GiB/workspace, "oldest eligible session first
 * after retention protection").
 *
 * Eligibility: a session is protected when it is the one that just wrote,
 * when the caller's `isProtected` seam says it holds a live replay-window
 * reservation, or when it has no sealed segments. Eviction removes the whole
 * oldest eligible session's sealed chain per step (the spec's session
 * granularity), re-accounts, and stops when nothing eligible remains — a
 * fully-protected scope may legitimately stay over its cap, and the attach
 * contract turns any pruned span into a deterministic resync, never a
 * partial replay.
 */
export function enforceScopeRetention(options: {
  runtimeRoot: string
  /** The session that just wrote; its own per-session pass just ran. */
  activeTerminalId: string
  maxBytes: number
  isProtected?: (terminalId: string) => boolean
}): ScopeEvictionResult {
  const { runtimeRoot } = options
  let names: string[]
  try {
    names = readdirSync(runtimeRoot)
  } catch {
    return { evictedSessions: [], bytesFreed: 0, remainingBytes: 0 }
  }
  const sessions = new Map<string, SealedSegment[]>()
  let remainingBytes = 0
  for (const name of names) {
    if (!UUID_DIR.test(name)) continue
    const segments = listSealedSegments(join(runtimeRoot, name))
    if (segments.length === 0) continue
    sessions.set(name, segments)
    remainingBytes += totalBytes(segments)
  }
  const evictedSessions: string[] = []
  let bytesFreed = 0
  while (remainingBytes > options.maxBytes) {
    let oldest: { terminalId: string; modifiedMs: number } | undefined
    for (const [terminalId, segments] of sessions) {
      if (terminalId === options.activeTerminalId) continue
      if (options.isProtected?.(terminalId)) continue
      // "Oldest" is the session's oldest sealed segment; the id breaks ties
      // so two scans of the same state pick the same session.
      const candidate = segments[0]!
      if (!oldest || candidate.modifiedMs < oldest.modifiedMs) {
        oldest = { terminalId, modifiedMs: candidate.modifiedMs }
      }
    }
    if (!oldest) break
    const segments = sessions.get(oldest.terminalId) ?? []
    let sessionFreed = 0
    let allRemoved = true
    for (const segment of segments) {
      if (!removeSegmentAtomically(join(runtimeRoot, oldest.terminalId), segment)) {
        allRemoved = false
        break
      }
      sessionFreed += segment.size
    }
    sessions.delete(oldest.terminalId)
    if (!allRemoved || sessionFreed === 0) break
    evictedSessions.push(oldest.terminalId)
    bytesFreed += sessionFreed
    remainingBytes -= sessionFreed
  }
  return { evictedSessions, bytesFreed, remainingBytes }
}
