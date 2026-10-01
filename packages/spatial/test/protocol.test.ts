import { describe, expect, test } from 'bun:test'
import {
  agentSimEngineManifestUrl,
  isLocalDevHost,
  isOfficialAgentSimWebOrigin,
  parseAgentSimEngineManifest,
} from '../src/engine'
import { hqHomeManifest, hqWorkManifest } from '../src/manifests'
import { encodeSceneStartPosition, readSceneStartPosition } from '../src/scene-spawn'
import { parseScenePerformanceReport } from '../src/telemetry'

describe('spatial protocol', () => {
  test('exposes stable HQ mount manifests', () => {
    expect(hqHomeManifest.id).toBe('hq-home')
    expect(hqWorkManifest.id).toBe('hq-work')
    expect(hqHomeManifest.zones).toEqual([])
    expect(hqHomeManifest.startPosition?.y).toBe(141)
  })

  test('round-trips scene start positions through URLs', () => {
    const position = { x: 1, y: 141, z: -2, yaw: 0.5, snapToGround: true as const }
    expect(readSceneStartPosition(encodeSceneStartPosition(position))).toEqual(position)
    expect(readSceneStartPosition('nope')).toBeUndefined()
  })

  test('rejects malformed telemetry reports', () => {
    expect(parseScenePerformanceReport(null)).toBeNull()
    expect(parseScenePerformanceReport({ version: 1 })).toBeNull()
  })

  test('entitles only official Agent Sim web origins', () => {
    expect(isOfficialAgentSimWebOrigin('https://adea.dev')).toBe(true)
    expect(isOfficialAgentSimWebOrigin('https://adea.io')).toBe(true)
    expect(isOfficialAgentSimWebOrigin('https://www.adea.dev')).toBe(true)
    expect(isOfficialAgentSimWebOrigin('https://app.adea.io/')).toBe(true)
    expect(isOfficialAgentSimWebOrigin('https://notadea.dev')).toBe(false)
    expect(isOfficialAgentSimWebOrigin('https://adea.dev.evil.example')).toBe(false)
    expect(isOfficialAgentSimWebOrigin('http://adea.dev')).toBe(false)
    expect(isOfficialAgentSimWebOrigin('https://adea-preview.workers.dev')).toBe(false)
    expect(isOfficialAgentSimWebOrigin('not a url')).toBe(false)
  })

  test('recognizes local development hosts', () => {
    expect(isLocalDevHost('localhost')).toBe(true)
    expect(isLocalDevHost('127.0.0.1')).toBe(true)
    expect(isLocalDevHost('adea.localhost')).toBe(true)
    expect(isLocalDevHost('adea.dev')).toBe(false)
  })

  test('resolves the engine manifest at the well-known same-origin path', () => {
    expect(agentSimEngineManifestUrl('https://adea.dev')).toBe(
      'https://adea.dev/assets/agent-sim/engine.json'
    )
    expect(agentSimEngineManifestUrl('http://127.0.0.1:3000')).toBe(
      'http://127.0.0.1:3000/assets/agent-sim/engine.json'
    )
  })

  test('validates engine manifests against the deployment origin', () => {
    const origin = 'https://adea.dev'
    expect(
      parseAgentSimEngineManifest(
        { engine: { entryUrl: '/assets/agent-sim/engine.js', version: '1.2.3' } },
        origin
      )
    ).toEqual({
      ok: true,
      manifest: { entryUrl: 'https://adea.dev/assets/agent-sim/engine.js', version: '1.2.3' },
    })
    expect(
      parseAgentSimEngineManifest(
        { engine: { entryUrl: 'https://cdn.evil.example/sim.js', version: '1' } },
        origin
      ).ok
    ).toBe(false)
    expect(parseAgentSimEngineManifest({ engine: { version: '1' } }, origin).ok).toBe(false)
    expect(parseAgentSimEngineManifest(null, origin).ok).toBe(false)
  })
})
