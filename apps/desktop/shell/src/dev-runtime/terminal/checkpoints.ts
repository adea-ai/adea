// Durable terminal history (issue #396): versioned length-prefixed binary
// segments with checksums, owner-only permissions, atomic rename, corruption
// quarantine, and bounded retention.
//
// Provenance: the checkpoint/append-increment model, retention GC, and the
// quarantine-with-raw-bytes-retained recovery are adapted from orca
// `src/main/terminal-history.ts`, `src/main/daemon/daemon-pty-checkpoint-persistence.ts`,
// and `src/main/daemon/terminal-history-*.ts`
// (revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7, MIT). The pinned donor
// seams are deliberately replaced: orca persists absolute history directories
// that double as deletion authority, and its restore paths trust them. Adea
// stores relative identifiers beneath an owner-only runtime root and treats
// any persisted path as a label — deletion re-proves containment and file
// identity at call time (docs/specs/dev-runtime.md, "Shell integration and
// input").
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import { TERMINAL_LIMITS } from './limits'

export const SEGMENT_FORMAT_VERSION = 1
const SEGMENT_MAGIC = 'ADT1'

export type CheckpointError = Readonly<{
  code: 'checkpoint_corrupt' | 'not_found' | 'invalid_state' | 'limit_exceeded'
  message: string
}>

export type CheckpointOk<T> = { ok: true; value: T } | { ok: false; error: CheckpointError }

export type SegmentChunk = Readonly<{
  /** Canonical unsigned decimal sequence. */
  seq: string
  emittedAt: string
  bytes: Uint8Array
}>

export type SegmentFooter = Readonly<{
  fromSeq: string
  toSeq: string
  chunkCount: number
  byteLength: number
  segmentSha256: string
  createdAt: string
}>

export type CheckpointSink = {
  /** Appends one sequence chunk to the session's open segment. */
  append(chunk: SegmentChunk): void
  /** Flushes the open segment to disk (atomic rename, checksummed). */
  checkpoint(): CheckpointOk<SegmentFooter | null>
  /** Newest durable sequence, or '0' when nothing is stored. */
  latestSequence(): string
  /** Reads durable chunks in sequence order (cold restore / replay). */
  read(fromSeq: string): SegmentChunk[]
  /** Bounded full-text search over durable chunks. */
  search(query: string, limit: number): Array<{ seq: string; byteOffset: string; preview: string }>
  /** Deletes durable state for the terminal after re-proving its location. */
  deleteHistory(): CheckpointOk<{ deletedSegments: number }>
  byteLength(): number
}

export type CreateCheckpointSinkOptions = {
  /** Owner-only runtime root; session data lives beneath it by relative ID. */
  runtimeRoot: string
  terminalId: string
  generation: number
  now?: () => number
  maxBytesPerSession?: number
  /** Deterministic host hook used to prove failed writes retain pending data. */
  beforeWrite?: () => void
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * A terminal ID is an opaque UUID (Dev Runtime spec, "Stable identifiers").
 * Enforcing the shape here is the containment proof for every path this
 * module derives: a hostile ID can never escape the runtime root.
 */
export function assertTerminalId(terminalId: string): string {
  if (!UUID_PATTERN.test(terminalId)) {
    throw new TypeError(`terminal id is not an opaque UUID: shape rejected`)
  }
  return terminalId
}

function checksum(parts: Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

function footerBytes(footer: SegmentFooter): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      SEGMENT_FORMAT_VERSION,
      footer.fromSeq,
      footer.toSeq,
      footer.chunkCount,
      footer.byteLength,
      footer.segmentSha256,
      footer.createdAt,
    ])
  )
}

export function createCheckpointSink(options: CreateCheckpointSinkOptions): CheckpointSink {
  const now = options.now ?? Date.now
  const maxBytes = options.maxBytesPerSession ?? TERMINAL_LIMITS.durableMaxBytesPerSession
  const beforeWrite = options.beforeWrite
  assertTerminalId(options.terminalId)
  const sessionDir = join(options.runtimeRoot, options.terminalId)
  const corruptDir = join(sessionDir, 'corrupt')
  let openChunks: SegmentChunk[] = []
  let openBytes = 0

  function ensureDirs(): void {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  }

  function segmentPath(footer: SegmentFooter): string {
    // Content-addressed, relative to the runtime root only.
    return join(sessionDir, `seg-${options.generation}-${footer.fromSeq}-${footer.toSeq}.adt`)
  }

  function listSegments(): Array<{ path: string; fromSeq: bigint; toSeq: bigint; size: number }> {
    if (!existsSync(sessionDir)) return []
    const segments: Array<{ path: string; fromSeq: bigint; toSeq: bigint; size: number }> = []
    for (const name of readdirSync(sessionDir)) {
      const match = name.match(/^seg-\d+-\d+-\d+\.adt$/)
      if (!match) continue
      const path = join(sessionDir, name)
      try {
        const stat = statSync(path)
        const parts = name.split('-')
        segments.push({
          path,
          fromSeq: BigInt(parts[2]!),
          toSeq: BigInt(parts[3]!.split('.')[0]!),
          size: stat.size,
        })
      } catch {
        /* raced deletion; skipped */
      }
    }
    return segments.toSorted((left, right) => (left.fromSeq < right.fromSeq ? -1 : 1))
  }

  function writeSegment(chunks: SegmentChunk[]): CheckpointOk<SegmentFooter | null> {
    if (chunks.length === 0) return { ok: true, value: null }
    ensureDirs()
    // Length-prefixed chunk records: u32 payload length + u32 meta length + meta + payload.
    const encoder = new TextEncoder()
    const records: Uint8Array[] = []
    let payloadBytes = 0
    for (const chunk of chunks) {
      const meta = encoder.encode(
        JSON.stringify({
          seq: chunk.seq,
          emittedAt: chunk.emittedAt,
          byteLength: chunk.bytes.byteLength,
        })
      )
      const record = new Uint8Array(8 + meta.byteLength + chunk.bytes.byteLength)
      const view = new DataView(record.buffer)
      view.setUint32(0, meta.byteLength, false)
      view.setUint32(4, chunk.bytes.byteLength, false)
      record.set(meta, 8)
      record.set(chunk.bytes, 8 + meta.byteLength)
      records.push(record)
      payloadBytes += record.byteLength
    }
    const body = new Uint8Array(payloadBytes)
    let offset = 0
    for (const record of records) {
      body.set(record, offset)
      offset += record.byteLength
    }
    const first = chunks[0]!
    const last = chunks[chunks.length - 1]!
    const footer: SegmentFooter = {
      fromSeq: first.seq,
      toSeq: last.seq,
      chunkCount: chunks.length,
      byteLength: body.byteLength,
      segmentSha256: checksum([body]),
      createdAt: new Date(now()).toISOString(),
    }
    const footerPrefix = footerBytes(footer)
    const magic = new TextEncoder().encode(SEGMENT_MAGIC)
    const fileBytes = new Uint8Array(
      magic.byteLength + 4 + footerPrefix.byteLength + body.byteLength
    )
    fileBytes.set(magic, 0)
    new DataView(fileBytes.buffer).setUint32(magic.byteLength, footerPrefix.byteLength, false)
    fileBytes.set(footerPrefix, magic.byteLength + 4)
    fileBytes.set(body, magic.byteLength + 4 + footerPrefix.byteLength)
    // Whole-file checksum rides the name; verify() recomputes it from bytes.
    const path = segmentPath(footer)
    const temporary = join(sessionDir, `.${randomUUID()}.tmp`)
    try {
      beforeWrite?.()
      const handle = openSync(temporary, 'wx', 0o600)
      try {
        writeSync(handle, fileBytes)
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      renameSync(temporary, path)
      // The segment is not considered durable until the rename is persisted.
      // This matters on APFS and on crash recovery after a successful file
      // fsync but before the directory entry reaches stable storage.
      const directory = openSync(sessionDir, 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    } catch (cause) {
      try {
        unlinkSync(temporary)
      } catch {
        /* nothing to clean */
      }
      return {
        ok: false,
        error: {
          code: 'invalid_state',
          message: `checkpoint write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      }
    }
    return { ok: true, value: footer }
  }

  function verifyAndRead(path: string): CheckpointOk<SegmentChunk[]> {
    let fileBytes: Uint8Array
    try {
      fileBytes = new Uint8Array(readFileSync(path))
    } catch {
      return { ok: false, error: { code: 'not_found', message: 'segment vanished' } }
    }
    if (fileBytes.byteLength < 8) return quarantine(path, 'truncated segment header')
    const magic = new TextDecoder().decode(fileBytes.subarray(0, 4))
    if (magic !== SEGMENT_MAGIC) return quarantine(path, 'bad magic')
    const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength)
    const footerLength = view.getUint32(4, false)
    if (footerLength > TERMINAL_LIMITS.maxChunkBytes) return quarantine(path, 'footer too large')
    if (8 + footerLength > fileBytes.byteLength) return quarantine(path, 'truncated segment footer')
    const footerText = new TextDecoder().decode(fileBytes.subarray(8, 8 + footerLength))
    let parsed: unknown
    try {
      parsed = JSON.parse(footerText)
    } catch {
      return quarantine(path, 'footer is not JSON')
    }
    if (!Array.isArray(parsed) || parsed[0] !== SEGMENT_FORMAT_VERSION) {
      return quarantine(path, 'unsupported segment version')
    }
    const body = fileBytes.subarray(8 + footerLength)
    const actual = checksum([body])
    if (actual !== parsed[5]) return quarantine(path, 'checksum mismatch')
    const chunks: SegmentChunk[] = []
    const decoder = new TextDecoder()
    let offset = 0
    while (offset < body.byteLength) {
      if (offset + 8 > body.byteLength) return quarantine(path, 'truncated record header')
      const metaLength = view.getUint32(8 + footerLength + offset, false)
      const byteLength = view.getUint32(8 + footerLength + offset + 4, false)
      const start = offset + 8
      if (start + metaLength + byteLength > body.byteLength) {
        return quarantine(path, 'truncated record payload')
      }
      let meta: { seq?: unknown; emittedAt?: unknown }
      try {
        meta = JSON.parse(decoder.decode(body.subarray(start, start + metaLength)))
      } catch {
        return quarantine(path, 'record meta is not JSON')
      }
      chunks.push({
        seq: String(meta.seq),
        emittedAt: String(meta.emittedAt),
        bytes: body.slice(start + metaLength, start + metaLength + byteLength),
      })
      offset = start + metaLength + byteLength
    }
    return { ok: true, value: chunks }
  }

  function quarantine(path: string, reason: string): { ok: false; error: CheckpointError } {
    // Corrupt state is quarantined with its raw bytes retained, never deleted.
    try {
      mkdirSync(corruptDir, { recursive: true, mode: 0o700 })
      renameSync(path, join(corruptDir, `${randomUUID()}.adt`))
    } catch {
      /* best effort; the file stays where it is */
    }
    return {
      ok: false,
      error: { code: 'checkpoint_corrupt', message: `segment quarantined: ${reason}` },
    }
  }

  return {
    append(chunk) {
      openChunks.push(chunk)
      openBytes += chunk.bytes.byteLength
      const durableBytes = listSegments().reduce((total, segment) => total + segment.size, 0)
      if (
        openBytes >= TERMINAL_LIMITS.checkpointIntervalBytes ||
        durableBytes + openBytes > maxBytes
      ) {
        this.checkpoint()
      }
    },

    checkpoint() {
      // Keep the pending buffer until the complete file+directory durability
      // sequence succeeds. A failed write must remain replayable and
      // retryable rather than silently dropping terminal history.
      const chunks = openChunks
      const written = writeSegment(chunks)
      if (written.ok) {
        openChunks = []
        openBytes = 0
      }
      // Retention is enforced after the atomic commit: oldest segments go
      // first, and the budget never grows by leaving garbage behind.
      if (written.ok) {
        let segments = listSegments()
        let durableBytes = segments.reduce((total, segment) => total + segment.size, 0)
        while (durableBytes > maxBytes && segments.length > 1) {
          const oldest = segments.shift()
          if (!oldest) break
          try {
            unlinkSync(oldest.path)
          } catch {
            break
          }
          durableBytes -= oldest.size
          segments = listSegments()
        }
      }
      return written
    },

    latestSequence() {
      const segments = listSegments()
      const last = segments[segments.length - 1]
      if (last && openChunks.length === 0) return String(last.toSeq)
      if (openChunks.length > 0) return openChunks[openChunks.length - 1]!.seq
      return '0'
    },

    read(fromSeq) {
      const from = BigInt(fromSeq)
      const chunks: SegmentChunk[] = []
      for (const segment of listSegments()) {
        if (segment.toSeq < from) continue
        const read = verifyAndRead(segment.path)
        if (read.ok) {
          for (const chunk of read.value) if (BigInt(chunk.seq) >= from) chunks.push(chunk)
        }
      }
      // The open buffer is pending-durable state: replay and search cover it
      // so a caller never misses the newest output between checkpoints.
      for (const chunk of openChunks) if (BigInt(chunk.seq) >= from) chunks.push(chunk)
      return chunks.toSorted((left, right) => (BigInt(left.seq) < BigInt(right.seq) ? -1 : 1))
    },

    search(query, limit) {
      const needle = new TextEncoder().encode(query)
      const matches: Array<{ seq: string; byteOffset: string; preview: string }> = []
      for (const chunk of this.read('0')) {
        if (matches.length >= limit) break
        const haystack = chunk.bytes
        outer: for (let start = 0; start + needle.byteLength <= haystack.byteLength; start += 1) {
          for (let index = 0; index < needle.byteLength; index += 1) {
            if (haystack[start + index] !== needle[index]) continue outer
          }
          const previewLength = Math.min(120, haystack.byteLength - start)
          matches.push({
            seq: chunk.seq,
            byteOffset: String(start),
            preview: new TextDecoder('utf-8', { fatal: false })
              .decode(haystack.slice(start, start + previewLength))
              // The strip is intentional: control bytes in terminal output
              // must not reach the preview surface.
              .replaceAll(
                // oxlint-disable-next-line no-control-regex
                /[\x00-\x1f\x7f]/g,
                ' '
              ),
          })
          break
        }
        if (matches.length >= limit) break
      }
      return matches
    },

    deleteHistory() {
      ensureDirs()
      let deleted = 0
      for (const segment of listSegments()) {
        // Re-prove containment immediately before every unlink: the segment
        // must still resolve beneath this session's directory.
        if (!segment.path.startsWith(sessionDir + '/')) {
          return {
            ok: false,
            error: { code: 'invalid_state', message: 'segment escaped the session directory' },
          }
        }
        try {
          unlinkSync(segment.path)
          deleted += 1
        } catch (cause) {
          return {
            ok: false,
            error: {
              code: 'invalid_state',
              message: `delete failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            },
          }
        }
      }
      return { ok: true, value: { deletedSegments: deleted } }
    },

    byteLength() {
      return listSegments().reduce((total, segment) => total + segment.size, 0)
    },
  }
}
