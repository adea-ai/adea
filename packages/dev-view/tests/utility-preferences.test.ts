import { describe, expect, test } from 'bun:test'

import {
  defaultLeftUtilitySize,
  defaultRightUtilitySize,
  defaultUtilityPreferences,
  snapUtilitySize,
  utilitySizeSteps,
} from '../src/utility-preferences'

describe('utility size steps and defaults', () => {
  test('the right ladder tops at 600 and the default is the shared top step', () => {
    expect(utilitySizeSteps.left).toEqual([240, 288, 336, 384])
    expect(utilitySizeSteps.right).toEqual([240, 288, 336, 384, 448, 512, 600])
    expect(defaultLeftUtilitySize).toBe(336)
    expect(defaultRightUtilitySize).toBe(600)
    expect(utilitySizeSteps.right.at(-1)).toBe(defaultRightUtilitySize)
  })

  test('default preferences seed six panes with the per-side defaults', () => {
    const preferences = defaultUtilityPreferences()
    expect(preferences.map((item) => item.pane)).toEqual([
      'files',
      'source_control',
      'browser',
      'devices',
      'agents',
      'history',
    ])
    expect(preferences.map((item) => item.visible)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ])
    for (const item of preferences) {
      const expected = item.side === 'left' ? defaultLeftUtilitySize : defaultRightUtilitySize
      expect(item.size).toBe(expected)
      expect(item.lastNonzeroSize).toBe(expected)
    }
  })

  test('snap lands on the nearest step, keeps ties on the lower step, and falls back on garbage', () => {
    expect(snapUtilitySize(600, 'right')).toBe(600)
    expect(snapUtilitySize(557, 'right')).toBe(600)
    // Exactly between 512 and 600 stays on the lower step.
    expect(snapUtilitySize(556, 'right')).toBe(512)
    expect(snapUtilitySize(536, 'right')).toBe(512)
    expect(snapUtilitySize(100, 'right')).toBe(240)
    expect(snapUtilitySize(Number.NaN, 'right')).toBe(defaultRightUtilitySize)
    expect(snapUtilitySize(Number.NaN, 'left')).toBe(defaultLeftUtilitySize)
    expect(snapUtilitySize(Number.POSITIVE_INFINITY, 'left')).toBe(defaultLeftUtilitySize)
  })
})
