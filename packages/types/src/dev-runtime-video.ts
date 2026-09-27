import {
  exactKeys,
  fail,
  integerValue,
  record,
  stringValue,
  uint64Pattern,
} from './dev-runtime-validation-internal'
import type { DevStreamFrame } from './dev-runtime'

export const DEV_STREAM_RELAY_ENVELOPE_BYTES_MAX = 128 * 1024
export const BROWSER_VIDEO_RELAY_CHUNK_BYTES_MAX = 64 * 1024
export const BROWSER_VIDEO_RELAY_CHUNKS_MAX = 128
export const BROWSER_VIDEO_FRAME_BYTES_MAX = 8 * 1024 * 1024
export const BROWSER_VIDEO_DIMENSION_MAX = 4096

export type DevStreamVideoFrame = Extract<DevStreamFrame, { type: 'video' }>

/** JSON-safe video payload used only on the authenticated shell relay event. */
export type DevStreamVideoRelayChunk = Readonly<{
  type: 'video_chunk'
  generation: number
  sequence: string
  timestampMs: number
  viewportSequence: number
  keyframe: boolean
  width: number
  height: number
  chunkIndex: number
  chunkCount: number
  byteOffset: number
  totalBytes: number
  bytes: string
}>

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64Values = new Map([...base64Alphabet].map((char, index) => [char, index]))

function relayBase64ByteLength(value: unknown, maxBytes: number, path: string): number {
  const text = stringValue(value, path, 4, Math.ceil(maxBytes / 3) * 4)
  if (
    text.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    fail(path, 'expected canonical base64')
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const byteLength = (text.length / 4) * 3 - padding
  if (byteLength <= 0 || byteLength > maxBytes) fail(path, 'base64 payload exceeds the bound')
  const finalValue = base64Values.get(text[text.length - padding - 1] ?? '')
  if (
    finalValue === undefined ||
    (padding === 2 && (finalValue & 0x0f) !== 0) ||
    (padding === 1 && (finalValue & 0x03) !== 0)
  )
    fail(path, 'expected canonical base64 padding')
  return byteLength
}

/** Strictly decodes standard base64 and refuses permissive Buffer/atob input. */
export function decodeDevStreamRelayBase64(value: unknown, maxBytes: number): Uint8Array {
  const byteLength = relayBase64ByteLength(value, maxBytes, 'relay bytes')
  const text = value as string
  const output = new Uint8Array(byteLength)
  let offset = 0
  for (let index = 0; index < text.length; index += 4) {
    const a = base64Values.get(text[index] ?? '')
    const b = base64Values.get(text[index + 1] ?? '')
    const c = text[index + 2] === '=' ? 0 : base64Values.get(text[index + 2] ?? '')
    const d = text[index + 3] === '=' ? 0 : base64Values.get(text[index + 3] ?? '')
    if (a === undefined || b === undefined || c === undefined || d === undefined)
      fail('relay bytes', 'expected canonical base64')
    const packed = (a << 18) | (b << 12) | (c << 6) | d
    if (offset < byteLength) output[offset++] = (packed >> 16) & 0xff
    if (offset < byteLength) output[offset++] = (packed >> 8) & 0xff
    if (offset < byteLength) output[offset++] = packed & 0xff
  }
  return output
}

function encodeRelayBase64(bytes: Uint8Array): string {
  let text = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0
    const b = bytes[index + 1] ?? 0
    const c = bytes[index + 2] ?? 0
    const triplet = (a << 16) | (b << 8) | c
    text += base64Alphabet[(triplet >> 18) & 63]
    text += base64Alphabet[(triplet >> 12) & 63]
    text += index + 1 < bytes.length ? base64Alphabet[(triplet >> 6) & 63] : '='
    text += index + 2 < bytes.length ? base64Alphabet[triplet & 63] : '='
  }
  return text
}

/** Validates the bounded browser frame without loading the full runtime registry. */
export function decodeDevStreamVideoFrame(value: unknown): DevStreamVideoFrame {
  const item = record(value, 'stream frame')
  exactKeys(
    item,
    [
      'type',
      'sequence',
      'timestampMs',
      'generation',
      'viewportSequence',
      'width',
      'height',
      'keyframe',
      'bytes',
    ],
    [],
    'stream frame'
  )
  if (item.type !== 'video') fail('stream frame.type', 'expected video')
  const sequence = stringValue(item.sequence, 'stream frame.sequence', 1, 64)
  if (!uint64Pattern.test(sequence))
    fail('stream frame.sequence', 'expected canonical uint64 string')
  integerValue(item.timestampMs, 'stream frame.timestampMs', 0)
  integerValue(item.generation, 'stream frame.generation', 0)
  integerValue(item.viewportSequence, 'stream frame.viewportSequence', 0)
  integerValue(item.width, 'stream frame.width', 1, BROWSER_VIDEO_DIMENSION_MAX)
  integerValue(item.height, 'stream frame.height', 1, BROWSER_VIDEO_DIMENSION_MAX)
  if (typeof item.keyframe !== 'boolean') fail('stream frame.keyframe', 'expected boolean')
  if (!(item.bytes instanceof Uint8Array)) fail('stream frame.bytes', 'expected Uint8Array')
  if (item.bytes.byteLength === 0 || item.bytes.byteLength > BROWSER_VIDEO_FRAME_BYTES_MAX)
    fail('stream frame.bytes', 'video frame exceeds 8 MiB')
  return value as DevStreamVideoFrame
}

export function encodeDevStreamVideoRelayChunks(
  frame: DevStreamVideoFrame
): readonly DevStreamVideoRelayChunk[] {
  const valid = decodeDevStreamVideoFrame(frame)
  const totalBytes = valid.bytes.byteLength
  if (totalBytes === 0 || totalBytes > BROWSER_VIDEO_FRAME_BYTES_MAX)
    fail('video frame.bytes', 'video frame exceeds 8 MiB')
  const chunkCount = Math.ceil(totalBytes / BROWSER_VIDEO_RELAY_CHUNK_BYTES_MAX)
  if (chunkCount > BROWSER_VIDEO_RELAY_CHUNKS_MAX)
    fail('video frame.bytes', 'video frame exceeds 128 chunks')
  const chunks: DevStreamVideoRelayChunk[] = []
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const byteOffset = chunkIndex * BROWSER_VIDEO_RELAY_CHUNK_BYTES_MAX
    const bytes = valid.bytes.subarray(
      byteOffset,
      Math.min(byteOffset + BROWSER_VIDEO_RELAY_CHUNK_BYTES_MAX, totalBytes)
    )
    chunks.push({
      type: 'video_chunk',
      generation: valid.generation,
      sequence: valid.sequence,
      timestampMs: valid.timestampMs,
      viewportSequence: valid.viewportSequence,
      keyframe: valid.keyframe,
      width: valid.width,
      height: valid.height,
      chunkIndex,
      chunkCount,
      byteOffset,
      totalBytes,
      bytes: encodeRelayBase64(bytes),
    })
  }
  return chunks
}

function uint64String(value: unknown, path: string): string {
  const text = stringValue(value, path, 1, 64)
  if (!uint64Pattern.test(text)) fail(path, 'expected canonical uint64 string')
  return text
}

export function decodeDevStreamRelayVideoChunk(value: unknown): DevStreamVideoRelayChunk {
  const item = record(value, 'video relay chunk')
  exactKeys(
    item,
    [
      'type',
      'generation',
      'sequence',
      'timestampMs',
      'viewportSequence',
      'keyframe',
      'width',
      'height',
      'chunkIndex',
      'chunkCount',
      'byteOffset',
      'totalBytes',
      'bytes',
    ],
    [],
    'video relay chunk'
  )
  if (item.type !== 'video_chunk') fail('video relay chunk.type', 'expected video_chunk')
  integerValue(item.generation, 'video relay chunk.generation', 0)
  uint64String(item.sequence, 'video relay chunk.sequence')
  integerValue(item.timestampMs, 'video relay chunk.timestampMs', 0)
  integerValue(item.viewportSequence, 'video relay chunk.viewportSequence', 0)
  if (typeof item.keyframe !== 'boolean') fail('video relay chunk.keyframe', 'expected boolean')
  integerValue(item.width, 'video relay chunk.width', 1, BROWSER_VIDEO_DIMENSION_MAX)
  integerValue(item.height, 'video relay chunk.height', 1, BROWSER_VIDEO_DIMENSION_MAX)
  const totalBytes = integerValue(
    item.totalBytes,
    'video relay chunk.totalBytes',
    1,
    BROWSER_VIDEO_FRAME_BYTES_MAX
  )
  const chunkCount = integerValue(
    item.chunkCount,
    'video relay chunk.chunkCount',
    1,
    BROWSER_VIDEO_RELAY_CHUNKS_MAX
  )
  const expectedCount = Math.ceil(totalBytes / BROWSER_VIDEO_RELAY_CHUNK_BYTES_MAX)
  if (chunkCount !== expectedCount) fail('video relay chunk.chunkCount', 'does not match length')
  const chunkIndex = integerValue(
    item.chunkIndex,
    'video relay chunk.chunkIndex',
    0,
    chunkCount - 1
  )
  const expectedOffset = chunkIndex * BROWSER_VIDEO_RELAY_CHUNK_BYTES_MAX
  const byteOffset = integerValue(
    item.byteOffset,
    'video relay chunk.byteOffset',
    0,
    totalBytes - 1
  )
  if (byteOffset !== expectedOffset) fail('video relay chunk.byteOffset', 'unexpected offset')
  const expectedChunkBytes = Math.min(BROWSER_VIDEO_RELAY_CHUNK_BYTES_MAX, totalBytes - byteOffset)
  if (
    relayBase64ByteLength(
      item.bytes,
      BROWSER_VIDEO_RELAY_CHUNK_BYTES_MAX,
      'video relay chunk.bytes'
    ) !== expectedChunkBytes
  )
    fail('video relay chunk.bytes', 'length does not match chunk offset')
  return value as DevStreamVideoRelayChunk
}

/** Enforces the serialized bound used by both authenticated relay legs. */
export function assertDevStreamRelayEnvelope(value: unknown): void {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    fail('relay envelope', 'could not be serialized')
  }
  if (typeof serialized !== 'string') fail('relay envelope', 'could not be serialized')
  const length = new TextEncoder().encode(serialized).byteLength
  if (length > DEV_STREAM_RELAY_ENVELOPE_BYTES_MAX) fail('relay envelope', 'exceeds 128 KiB')
}
