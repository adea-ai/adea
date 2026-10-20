import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

import { LIMITS, trustDomain } from './vp-r2-cache.mjs'
import { createMemoryStore } from './vp-r2-cache-fixtures.mjs'
import { pinnedClient, replayPinnedClient, serveTransport } from './vp-r2-cache-replay.mjs'

// The replay drives the pinned `vite-plus` client of this checkout. A checkout without dependencies reports that
// plainly and the test says so; a checkout with the client runs the whole proof.
const client = pinnedClient(process.cwd())

describe('the pinned client replay', () => {
  test('names the pinned client of this checkout', () => {
    if (!client) {
      expect(existsSync('node_modules/vite-plus/package.json')).toBe(false)
      return
    }
    expect(client.asked).toContain(client.version)
  })

  test('restores the generated outputs from the transport after the local cache and the outputs are removed', async () => {
    const result = await replayPinnedClient()
    if (result.skipped) {
      expect(result.reason).toContain('vite-plus')
      return
    }
    expect(result.failed).toBeUndefined()
    expect(result.firstExitCode).toBe(0)
    expect(result.secondExitCode).toBe(0)
    expect(result.localCacheRemoved).toBe(true)
    expect(result.outputsRemoved).toBe(true)
    expect(result.remoteHit).toBe(true)
    expect(result.restored).toBe(true)
    expect(result.bytesMatch).toBe(true)
    expect(result.sha256).toBe(result.expectedSha256)
  }, 300_000)
})

describe('the replay adapter', () => {
  test('answers an input that is over the limit with one valid 413', async () => {
    const scope = trustDomain({
      namespace: 'adea-ai/adea',
      client: '1.3.0',
      toolchain: 'vp-r2-cache-replay',
    })
    const store = createMemoryStore()
    const bridge = await serveTransport(scope, store)
    try {
      const over = LIMITS.maxRequestBytes + 1024
      const answer = await fetch(`http://127.0.0.1:${bridge.port}/store`, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=adea-boundary' },
        body: Buffer.alloc(over, 0x61),
      })
      expect(answer.status).toBe(413)
      expect(answer.headers.get('content-type')).toContain('application/json')
      // The body is a single, valid answer.
      expect(await answer.json()).toEqual({ error: 'the request is larger than the limit' })
      // Nothing was buffered beyond the limit, and nothing was stored.
      expect(store.objects.size).toBe(0)
    } finally {
      await bridge.close()
    }
  }, 120_000)
})
