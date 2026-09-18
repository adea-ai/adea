// Devices pane model: inventory grouping with typed capability guidance.
import { describe, expect, test } from 'bun:test'

import { groupDeviceInventory } from '../src/devices/device-model'

const item = (
  overrides: Partial<{ id: string; kind: string; name: string; state: string }> = {}
) => ({
  id: overrides.id ?? 'udid-1',
  kind: (overrides.kind ?? 'ios_simulator') as never,
  name: overrides.name ?? 'iPhone 16',
  platform: overrides.kind === 'android_emulator' ? 'android' : 'ios',
  state: (overrides.state ?? 'available') as never,
  generation: 0,
  observedAt: '2026-09-18T12:00:00.000Z',
})

describe('device inventory grouping', () => {
  test('responsive ships first; iOS and Android lists follow', () => {
    const groups = groupDeviceInventory(
      [item(), item({ id: 'emulator-5554', kind: 'android_emulator', name: 'Pixel_8' })],
      {
        ios: true,
        android: true,
      }
    )
    expect(groups.map((group) => group.platform)).toEqual(['responsive', 'ios', 'android'])
    expect(groups[0].items).toEqual([])
    expect(groups[1].items).toHaveLength(1)
    expect(groups[2].items).toHaveLength(1)
  })

  test('missing toolchains show typed guidance instead of an empty list', () => {
    const groups = groupDeviceInventory([], { ios: false, android: false })
    expect(groups[1].guidance).toMatch(/Xcode Simulator tools are unavailable/)
    expect(groups[2].guidance).toMatch(/Android SDK not found/)
  })

  test('present toolchains without devices show no guidance (genuinely empty)', () => {
    const groups = groupDeviceInventory([], { ios: true, android: true })
    expect(groups[1].guidance).toBeUndefined()
    expect(groups[2].guidance).toBeUndefined()
  })
})
