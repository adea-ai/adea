import { expect, test } from 'bun:test'
import { createApiClient } from '../../src'

test('Sim uses the existing desktop or temporary transport identity and abort signal', async () => {
  const seen: { url: string; init: RequestInit }[] = []
  const client = createApiClient({
    client: 'desktop',
    getTemporaryCredential: () => 'fixture-only',
    fetchImpl: (async (url, init) => {
      seen.push({ url: String(url), init: init! })
      return Response.json({ frameOrigin: null })
    }) as typeof fetch,
  })
  const signal = new AbortController().signal
  await client.simConfiguration(signal)
  await client.requestSimLaunch({ schemaVersion: 1 }, signal)
  expect(seen.map((request) => request.url)).toEqual(['/api/sim/config', '/api/sim/launch'])
  for (const request of seen) {
    expect(new Headers(request.init.headers).get('authorization')).toBe('Temporary fixture-only')
    expect(new Headers(request.init.headers).get('x-adea-client')).toBe('desktop')
    expect(request.init.credentials).toBe('omit')
    expect(request.init.signal).toBe(signal)
  }
})
