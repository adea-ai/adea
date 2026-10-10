import { describe, expect, test } from 'bun:test'

import { readBoundedRequestBytes } from '../src/server/bounded-request-body'

const LIMIT = 4_096
const CHUNK = 1_024

/**
 * A stream of CHUNK-byte pieces that counts how often it is pulled and whether it was
 * cancelled. `highWaterMark: 0` keeps the stream from pulling before a read, so the count
 * is reads only. It errors after 100 pulls, so an unbounded reader fails the count
 * assertions below rather than hanging. No large fixture is ever built.
 */
function countedStream(chunks: number) {
  const state = { cancelled: false, pulls: 0 }
  const body = new ReadableStream<Uint8Array>(
    {
      cancel() {
        state.cancelled = true
      },
      pull(controller) {
        state.pulls += 1
        if (state.pulls > 100) {
          controller.error(new Error('unbounded read'))
          return
        }
        if (state.pulls > chunks) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20))
      },
    },
    { highWaterMark: 0 }
  )
  return { body, state }
}

function requestOf(body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) {
  return { body, headers: new Headers(headers) }
}

describe('readBoundedRequestBytes', () => {
  test('a body within the limit is returned whole, in order', async () => {
    const first = new Uint8Array([1, 2, 3])
    const second = new Uint8Array([4, 5])
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first)
        controller.enqueue(second)
        controller.close()
      },
    })
    expect(Array.from((await readBoundedRequestBytes(requestOf(body), LIMIT))!)).toEqual([
      1, 2, 3, 4, 5,
    ])
  })

  test('an omitted Content-Length is not trusted: the stream is cancelled at the first chunk past the limit', async () => {
    const { body, state } = countedStream(100)
    expect(await readBoundedRequestBytes(requestOf(body), LIMIT)).toBeNull()
    expect(state.cancelled).toBe(true)
    // Four chunks fit the limit; the fifth crosses it. One read ahead is allowed, nothing more.
    expect(state.pulls).toBeLessThanOrEqual(6)
  })

  test('a false Content-Length is refused before any byte is read', async () => {
    const { body, state } = countedStream(100)
    expect(
      await readBoundedRequestBytes(requestOf(body, { 'content-length': 'false' }), LIMIT)
    ).toBeNull()
    expect(state.pulls).toBe(0)
    expect(state.cancelled).toBe(false)
  })

  test('a Content-Length above the limit is refused before any byte is read', async () => {
    const { body, state } = countedStream(1)
    expect(
      await readBoundedRequestBytes(requestOf(body, { 'content-length': '999999999999' }), LIMIT)
    ).toBeNull()
    expect(state.pulls).toBe(0)
  })

  test('a small Content-Length does not let an overflowing stream through', async () => {
    const { body, state } = countedStream(100)
    expect(
      await readBoundedRequestBytes(requestOf(body, { 'content-length': '10' }), LIMIT)
    ).toBeNull()
    expect(state.cancelled).toBe(true)
    expect(state.pulls).toBeLessThanOrEqual(6)
  })

  test('a stream that errors mid-read resolves to null, not a thrown error', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(CHUNK))
        controller.error(new Error('connection reset'))
      },
    })
    expect(await readBoundedRequestBytes(requestOf(body), LIMIT)).toBeNull()
  })

  test('a request with no body is refused', async () => {
    expect(await readBoundedRequestBytes(requestOf(null), LIMIT)).toBeNull()
  })
})
