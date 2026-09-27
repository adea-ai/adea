import { describe, expect, test } from 'bun:test'

import {
  BROWSER_VIDEO_FRAME_BYTES_MAX,
  encodeDevStreamVideoRelayChunks,
} from '@adea-ai/types/dev-runtime'
import { createBrowserVideoReassembler } from '../src/lib/browser-video-reassembly'

function video(sequence: string, byteLength = 65_537) {
  return {
    type: 'video' as const,
    sequence,
    timestampMs: 1234,
    generation: 7,
    viewportSequence: 9,
    width: 1280,
    height: 720,
    keyframe: true,
    bytes: Uint8Array.from({ length: byteLength }, (_, index) => index % 251),
  }
}

describe('browser video relay reassembly', () => {
  test('delivers only the complete frame with generation and viewport metadata', () => {
    const reassembler = createBrowserVideoReassembler({ generation: 7 })
    const chunks = encodeDevStreamVideoRelayChunks(video('1'))
    expect(reassembler.push(chunks[0])).toBeUndefined()
    const frame = reassembler.push(chunks[1])
    expect(frame).toMatchObject({
      type: 'video',
      sequence: '1',
      generation: 7,
      viewportSequence: 9,
      width: 1280,
      height: 720,
      keyframe: true,
    })
    expect(frame?.bytes).toEqual(video('1').bytes)
  })

  test('rejects duplicate, skipped, metadata-changing, and stale-generation chunks', () => {
    const reassembler = createBrowserVideoReassembler({ generation: 7 })
    const chunks = encodeDevStreamVideoRelayChunks(video('1'))
    expect(() => reassembler.push(chunks[1])).toThrow('start at offset zero')
    expect(reassembler.push(chunks[0])).toBeUndefined()
    expect(() => reassembler.push(chunks[0])).toThrow('chunk order')

    const next = createBrowserVideoReassembler({ generation: 7 })
    expect(next.push(chunks[0])).toBeUndefined()
    expect(() => next.push({ ...chunks[1], viewportSequence: 10 })).toThrow('metadata changed')

    const stale = createBrowserVideoReassembler({ generation: 7 })
    expect(stale.push(chunks[0])).toBeUndefined()
    expect(stale.pending).toBe(true)
    expect(() => stale.push({ ...chunks[0], generation: 8 })).toThrow('generation')
    expect(stale.pending).toBe(false)
  })

  test('bounds one incomplete frame and discards it on timeout or close', () => {
    let expire: (() => void) | undefined
    const reassembler = createBrowserVideoReassembler({
      generation: 7,
      setTimer: (callback) => {
        expire = callback
        return callback
      },
      clearTimer: (timer) => {
        if (expire === timer) expire = undefined
      },
    })
    const chunks = encodeDevStreamVideoRelayChunks(video('1'))
    expect(reassembler.push(chunks[0])).toBeUndefined()
    const timedOut = expire
    timedOut?.()
    expect(reassembler.pending).toBe(false)
    expect(() => reassembler.push(chunks[1])).toThrow('start at offset zero')
    expect(reassembler.push(encodeDevStreamVideoRelayChunks(video('2'))[0])).toBeUndefined()
    reassembler.close()
    expect(reassembler.pending).toBe(false)

    const boundedPending = createBrowserVideoReassembler({ generation: 7 })
    const sequenceThree = encodeDevStreamVideoRelayChunks(video('3'))
    expect(boundedPending.push(sequenceThree[0])).toBeUndefined()
    expect(() => boundedPending.push(encodeDevStreamVideoRelayChunks(video('4'))[0])).toThrow(
      'incomplete frame'
    )
    expect(boundedPending.pending).toBe(false)
    expect(boundedPending.push(encodeDevStreamVideoRelayChunks(video('4'))[0])).toBeUndefined()
    boundedPending.close()

    const maximum = video('5', BROWSER_VIDEO_FRAME_BYTES_MAX)
    const maximumChunks = encodeDevStreamVideoRelayChunks(maximum)
    expect(maximumChunks).toHaveLength(128)
    const bounded = createBrowserVideoReassembler({ generation: 7 })
    let completeMaximum: ReturnType<typeof bounded.push> = undefined
    for (const chunk of maximumChunks) completeMaximum = bounded.push(chunk)
    expect(completeMaximum?.bytes).toEqual(maximum.bytes)
    expect(bounded.pending).toBe(false)
    expect(() => bounded.push(maximumChunks[0])).toThrow('not increasing')
    bounded.close()
  })
})
