import { describe, expect, test } from 'bun:test'
import { resolveAgentSimEngine } from '../../src/agent-sim-engine'

const OFFICIAL_MANIFEST = {
  engine: { entryUrl: '/assets/agent-sim/engine.js', version: '1.0.0' },
}

function fetchReturning(status: number, body: unknown = {}) {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('Agent Sim engine entitlement', () => {
  test('is unavailable when no engine manifest is packed', async () => {
    const outcome = await resolveAgentSimEngine('web', 'https://adea.dev', fetchReturning(404))
    expect(outcome).toEqual({ state: 'unavailable' })
  })

  test('is unavailable when the manifest fetch fails or is malformed', async () => {
    const failing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await resolveAgentSimEngine('web', 'https://adea.dev', failing)).toEqual({
      state: 'unavailable',
    })
    expect(
      await resolveAgentSimEngine('web', 'https://adea.dev', fetchReturning(200, { nope: true }))
    ).toEqual({ state: 'unavailable' })
  })

  test('entitles desktop builds whenever the engine is packed', async () => {
    const outcome = await resolveAgentSimEngine(
      'desktop',
      'tauri://localhost',
      fetchReturning(200, OFFICIAL_MANIFEST)
    )
    expect(outcome.state).toBe('entitled')
  })

  test('entitles official web domains when the engine is served', async () => {
    for (const origin of ['https://adea.dev', 'https://adea.io', 'https://www.adea.io']) {
      const outcome = await resolveAgentSimEngine(
        'web',
        origin,
        fetchReturning(200, OFFICIAL_MANIFEST)
      )
      expect(outcome.state).toBe('entitled')
    }
  })

  test('refuses forked web origins before trusting the engine', async () => {
    const outcome = await resolveAgentSimEngine(
      'web',
      'https://fork.example',
      fetchReturning(200, OFFICIAL_MANIFEST)
    )
    expect(outcome).toEqual({ state: 'refused' })
  })

  test('allows packed local development builds', async () => {
    const outcome = await resolveAgentSimEngine(
      'web',
      'http://127.0.0.1:3000',
      fetchReturning(200, OFFICIAL_MANIFEST)
    )
    expect(outcome.state).toBe('entitled')
  })
})
