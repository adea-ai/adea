import { describe, expect, test } from 'bun:test'
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
})
