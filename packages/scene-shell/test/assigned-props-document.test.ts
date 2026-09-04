import { afterEach, describe, expect, test } from 'bun:test'
import {
  invalidateAssignedPropsManifest,
  loadAssignedPropsManifest,
} from '../src/assigned-props-document'

const originalFetch = globalThis.fetch
const manifestUrl = '/assets/worlds/hq-home/props-runtime.json?v=room-layout'

afterEach(() => {
  globalThis.fetch = originalFetch
  invalidateAssignedPropsManifest(manifestUrl)
})

describe('assigned props manifest loader', () => {
  test('coalesces concurrent requests without loading the editor document', async () => {
    let requestCount = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestCount += 1
      expect(String(input)).toBe(manifestUrl)
      return new Response(JSON.stringify({ assets: {}, placements: {} }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const [first, second] = await Promise.all([
      loadAssignedPropsManifest(manifestUrl),
      loadAssignedPropsManifest(manifestUrl),
    ])

    expect(requestCount).toBe(1)
    expect(first).toEqual(second)
  })

  test('invalidating a manifest forces the next request to reload it', async () => {
    let requestCount = 0
    globalThis.fetch = (async () => {
      requestCount += 1
      return new Response(JSON.stringify({ version: requestCount, assets: {}, placements: {} }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const first = await loadAssignedPropsManifest(manifestUrl)
    invalidateAssignedPropsManifest(manifestUrl)
    const second = await loadAssignedPropsManifest(manifestUrl)

    expect(requestCount).toBe(2)
    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
  })
})
