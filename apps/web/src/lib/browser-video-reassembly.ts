import {
  BROWSER_VIDEO_FRAME_BYTES_MAX,
  BROWSER_VIDEO_RELAY_CHUNK_BYTES_MAX,
  decodeDevStreamRelayBase64,
  decodeDevStreamRelayVideoChunk,
  type DevStreamFrame,
} from '@adea-ai/types/dev-runtime'

export const BROWSER_VIDEO_REASSEMBLY_TIMEOUT_MS = 5_000

type VideoFrame = Extract<DevStreamFrame, { type: 'video' }>
type VideoRelayChunk = ReturnType<typeof decodeDevStreamRelayVideoChunk>

type PartialFrame = {
  first: VideoRelayChunk
  bytes: Uint8Array
  nextIndex: number
  receivedBytes: number
  timer?: unknown
}

function sameMetadata(left: VideoRelayChunk, right: VideoRelayChunk): boolean {
  return (
    left.generation === right.generation &&
    left.sequence === right.sequence &&
    left.timestampMs === right.timestampMs &&
    left.viewportSequence === right.viewportSequence &&
    left.keyframe === right.keyframe &&
    left.width === right.width &&
    left.height === right.height &&
    left.chunkCount === right.chunkCount &&
    left.totalBytes === right.totalBytes
  )
}

/** Reassembles one authenticated browser frame without acknowledging partial data. */
export function createBrowserVideoReassembler(options: {
  generation: number
  maxFrameBytes?: number
  timeoutMs?: number
  onTimeout?: () => void
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
}) {
  const timeoutMs = options.timeoutMs ?? BROWSER_VIDEO_REASSEMBLY_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('video reassembly timeout must be between 1 and 60000 ms')
  const maxFrameBytes = options.maxFrameBytes ?? BROWSER_VIDEO_FRAME_BYTES_MAX
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 1 ||
    maxFrameBytes > BROWSER_VIDEO_FRAME_BYTES_MAX
  )
    throw new Error('video reassembly frame bound must be between 1 byte and 8 MiB')
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))

  let partial: PartialFrame | undefined
  let highestSequence: bigint | undefined
  let closed = false

  function dropPartial(): void {
    const prior = partial
    partial = undefined
    if (prior?.timer !== undefined) clearTimer(prior.timer)
  }

  return {
    push(value: unknown): VideoFrame | undefined {
      if (closed) throw new Error('video reassembler is closed')
      const chunk = decodeDevStreamRelayVideoChunk(value)
      if (chunk.generation !== options.generation) {
        dropPartial()
        throw new Error('video chunk generation does not match the attached grant')
      }
      if (chunk.totalBytes > maxFrameBytes) {
        dropPartial()
        throw new Error('video frame exceeds the attached grant limit')
      }

      if (!partial) {
        if (chunk.chunkIndex !== 0 || chunk.byteOffset !== 0)
          throw new Error('video chunk sequence must start at offset zero')
        const sequence = BigInt(chunk.sequence)
        if (highestSequence !== undefined && sequence <= highestSequence)
          throw new Error('video frame sequence is not increasing')
        highestSequence = sequence
        const current: PartialFrame = {
          first: chunk,
          bytes: new Uint8Array(chunk.totalBytes),
          nextIndex: 0,
          receivedBytes: 0,
        }
        current.timer = setTimer(() => {
          if (partial === current) {
            partial = undefined
            current.timer = undefined
            options.onTimeout?.()
          }
        }, timeoutMs)
        partial = current
      }

      const current = partial
      if (chunk.sequence !== current.first.sequence) {
        dropPartial()
        throw new Error('incomplete frame arrived before the next sequence')
      }
      if (!sameMetadata(current.first, chunk)) {
        dropPartial()
        throw new Error('video chunk metadata changed during reassembly')
      }
      if (chunk.chunkIndex !== current.nextIndex || chunk.byteOffset !== current.receivedBytes) {
        dropPartial()
        throw new Error('video chunk order contains a duplicate or gap')
      }

      const bytes = decodeDevStreamRelayBase64(chunk.bytes, BROWSER_VIDEO_RELAY_CHUNK_BYTES_MAX)
      current.bytes.set(bytes, chunk.byteOffset)
      current.nextIndex += 1
      current.receivedBytes += bytes.byteLength
      if (current.nextIndex !== chunk.chunkCount) return undefined
      if (current.receivedBytes !== chunk.totalBytes) {
        dropPartial()
        throw new Error('video frame length does not match its chunks')
      }

      dropPartial()
      return {
        type: 'video',
        sequence: chunk.sequence,
        timestampMs: chunk.timestampMs,
        generation: chunk.generation,
        viewportSequence: chunk.viewportSequence,
        width: chunk.width,
        height: chunk.height,
        keyframe: chunk.keyframe,
        bytes: current.bytes,
      }
    },

    close(): void {
      closed = true
      dropPartial()
    },

    get pending(): boolean {
      return partial !== undefined
    },
  }
}
