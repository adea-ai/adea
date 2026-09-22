// Wire envelope for the authenticated full-duplex channel's bulk stream
// (`dev.runtime.stream.attach.v1`). Every WebSocket message is binary:
//
//   [marker byte][payload]
//
// Control frames (`opened`, `ack`, `heartbeat`, `resync`, `error`, `close`)
// carry canonical CBOR of the frame object without its `type`. Byte-bearing
// frames (`data`, `video`, `input`, `gesture`, `resize`) carry canonical CBOR
// of their metadata plus an exact `byteLength`, followed by the raw bytes —
// payload bytes are never JSON/base64-transcoded. Control frames are bounded
// at 64 KiB per the Dev Runtime spec.
import {
  decodeCbor,
  decodeDevStreamFrame,
  encodeCbor,
  type DevStreamFrame,
  type DevStreamGrant,
} from '../../../../../../packages/types/src/dev-runtime'

export const STREAM_CONTROL_MAX_BYTES = 64 * 1024

const FRAME_TAGS = {
  opened: 0x01,
  data: 0x02,
  video: 0x03,
  input: 0x04,
  gesture: 0x05,
  resize: 0x06,
  ack: 0x07,
  heartbeat: 0x08,
  resync: 0x09,
  error: 0x0a,
  close: 0x0b,
} as const satisfies Record<DevStreamFrame['type'], number>

const TAG_FRAME_TYPES = new Map<number, DevStreamFrame['type']>(
  (Object.entries(FRAME_TAGS) as [DevStreamFrame['type'], number][]).map(([type, tag]) => [
    tag,
    type,
  ])
)

const BYTE_FRAME_TYPES = new Set(['data', 'video', 'input', 'gesture', 'resize'])

/** Encodes one stream frame; refuses frames the DTO decoder rejects. */
export function encodeStreamFrame(frame: DevStreamFrame): Uint8Array {
  const valid = decodeDevStreamFrame(frame)
  const tag = FRAME_TAGS[valid.type]
  if (!BYTE_FRAME_TYPES.has(valid.type)) {
    const { type: _type, ...control } = valid
    const encoded = encodeCbor(control)
    if (encoded.byteLength > STREAM_CONTROL_MAX_BYTES) {
      throw new Error('stream control frame exceeds 64 KiB')
    }
    const out = new Uint8Array(1 + encoded.byteLength)
    out[0] = tag
    out.set(encoded, 1)
    return out
  }
  const bytes = (valid as { bytes?: Uint8Array }).bytes ?? new Uint8Array(0)
  const {
    type: _type,
    bytes: _bytes,
    ...metadata
  } = valid as Record<string, unknown> & {
    type: string
    bytes?: Uint8Array
  }
  const encoded = encodeCbor({ ...metadata, byteLength: bytes.byteLength })
  if (encoded.byteLength > STREAM_CONTROL_MAX_BYTES) {
    throw new Error('stream frame header exceeds 64 KiB')
  }
  const out = new Uint8Array(1 + encoded.byteLength + bytes.byteLength)
  out[0] = tag
  out.set(encoded, 1)
  out.set(bytes, 1 + encoded.byteLength)
  return out
}

/** Parses one binary WebSocket message into a stream frame. */
export function parseStreamFrame(message: Uint8Array): DevStreamFrame {
  if (message.byteLength === 0) throw new Error('empty stream frame')
  const type = TAG_FRAME_TYPES.get(message[0]!)
  if (!type) throw new Error('unknown stream frame marker')
  if (BYTE_FRAME_TYPES.has(type)) {
    const decoded = decodeCbor(message.subarray(1))
    const metadata = decoded.value as Record<string, unknown>
    if (typeof metadata.byteLength !== 'number') throw new Error('frame header lacks byteLength')
    const start = 1 + decoded.byteLength
    if (message.byteLength - start !== metadata.byteLength) {
      throw new Error('frame payload does not match its declared byteLength')
    }
    const bytes = message.slice(start)
    const { byteLength: _byteLength, ...rest } = metadata
    return decodeDevStreamFrame({ type, ...rest, bytes })
  }
  if (message.byteLength - 1 > STREAM_CONTROL_MAX_BYTES) {
    throw new Error('stream control frame exceeds 64 KiB')
  }
  const decoded = decodeCbor(message.subarray(1))
  return decodeDevStreamFrame({ type, ...(decoded.value as object) })
}

export type StreamCloseCode = Extract<DevStreamFrame, { type: 'close' }>['code']

export type StreamInboundVerdict =
  | { ok: true }
  | { ok: false; closeCode: StreamCloseCode; reason: string }

/**
 * Per-attach inbound validator: wrong-direction frames, oversize payloads,
 * mis-sequenced client frames, and stale generations are rejected and close
 * the stream. `read` grants only accept client credit (`ack`); `write` grants
 * only accept client input (`input`/`gesture`/`resize`). The two directions
 * sequence client frames differently, so the rules differ too:
 *
 *  - `input` frames carry byte-OFFSET sequences: the first chunk must land
 *    exactly on the grant's `fromSequence` and every later chunk on the
 *    running offset end (previous offset + bytes length). A higher offset is
 *    a gap; a lower one replays or overlaps bytes the cursor already passed.
 *    Both close typed (`incompatible`), exactly like the old ordering refusals.
 *  - Byte-less `gesture`/`resize` frames carry event counters, not offsets:
 *    strictly increasing, and never behind the offset end bytes have consumed.
 */
export function createStreamInbound(grant: DevStreamGrant) {
  let closed = false
  let offsetEnd = BigInt(grant.fromSequence)
  let lastEventSequence = BigInt(grant.fromSequence)

  function accept(frame: DevStreamFrame): StreamInboundVerdict {
    if (closed) return { ok: false, closeCode: 'normal', reason: 'stream is closed' }
    const clientInput =
      frame.type === 'input' || frame.type === 'gesture' || frame.type === 'resize'
    if (grant.direction === 'read') {
      if (frame.type !== 'ack') {
        closed = true
        return { ok: false, closeCode: 'incompatible', reason: 'input on a read grant' }
      }
      return { ok: true }
    }
    if (!clientInput) {
      closed = true
      return { ok: false, closeCode: 'incompatible', reason: `${frame.type} on a write grant` }
    }
    if ('generation' in frame && frame.generation !== grant.resource.generation) {
      closed = true
      return { ok: false, closeCode: 'stale_generation', reason: 'input generation is stale' }
    }
    if ('sequence' in frame) {
      const sequence = BigInt(frame.sequence)
      if (frame.type === 'input') {
        if (sequence !== offsetEnd) {
          closed = true
          return {
            ok: false,
            closeCode: 'incompatible',
            reason:
              sequence > offsetEnd
                ? 'client offset skips ahead of the write cursor'
                : 'client offset replays bytes the write cursor already passed',
          }
        }
        offsetEnd += BigInt(frame.bytes.byteLength)
      } else if (sequence < offsetEnd || sequence <= lastEventSequence) {
        closed = true
        return { ok: false, closeCode: 'incompatible', reason: 'client sequence went backwards' }
      } else {
        lastEventSequence = sequence
      }
    }
    if ('bytes' in frame && frame.bytes.byteLength > grant.maxFrameBytes) {
      closed = true
      return { ok: false, closeCode: 'backpressure', reason: 'frame exceeds the grant limit' }
    }
    return { ok: true }
  }

  function markClosed(): void {
    closed = true
  }

  return { accept, markClosed }
}
