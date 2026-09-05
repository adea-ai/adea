import { afterEach, describe, expect, test } from 'bun:test'
import {
  invalidateRoomDesignerDocument,
  loadRoomDesignerDocument,
} from '../src/room-designer-document'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  invalidateRoomDesignerDocument('home')
})

describe('room designer document loader', () => {
  test('coalesces concurrent requests for the same scene', async () => {
    let requestCount = 0
    globalThis.fetch = (async () => {
      requestCount += 1
      return new Response(JSON.stringify({ scene: 'home', placements: {} }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const [first, second] = await Promise.all([
      loadRoomDesignerDocument('home'),
      loadRoomDesignerDocument('home'),
    ])

    expect(requestCount).toBe(1)
    expect(first).toEqual(second)
  })

  test('invalidating a scene forces the next request to reload it', async () => {
    let requestCount = 0
    globalThis.fetch = (async () => {
      requestCount += 1
      return new Response(JSON.stringify({ scene: 'home', version: requestCount }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const first = await loadRoomDesignerDocument('home')
    invalidateRoomDesignerDocument('home')
    const second = await loadRoomDesignerDocument('home')

    expect(requestCount).toBe(2)
    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
  })
})
