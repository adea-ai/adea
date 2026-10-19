import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

import { pinnedClient, replayPinnedClient } from './vp-r2-cache-replay.mjs'

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
