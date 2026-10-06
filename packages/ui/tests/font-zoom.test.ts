import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS,
  APPEARANCE_EDITOR_FONT_SIZE_MAX,
  APPEARANCE_EDITOR_FONT_SIZE_MIN,
} from '@adea-ai/ui/lib/appearance-font-settings'

import { fontZoomShortcut, stepAppearanceFontSizes } from '../src/components/font-zoom'

const key = (overrides: Partial<Parameters<typeof fontZoomShortcut>[0]> = {}) => ({
  key: '=',
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  ...overrides,
})

describe('font zoom chords', () => {
  test('Cmd/Ctrl with = or + steps in, with - steps out, with 0 resets', () => {
    expect(fontZoomShortcut(key({ key: '=' }))).toBe('in')
    expect(fontZoomShortcut(key({ key: '+', metaKey: true, ctrlKey: false }))).toBe('in')
    // Ctrl is the Windows/Linux modifier for the same chord.
    expect(fontZoomShortcut(key({ key: '=', ctrlKey: true, metaKey: false }))).toBe('in')
    // Shift+ equals produces the '+' key on US layouts.
    expect(fontZoomShortcut(key({ key: '+' }))).toBe('in')
    expect(fontZoomShortcut(key({ key: '-' }))).toBe('out')
    expect(fontZoomShortcut(key({ key: '0' }))).toBe('reset')
  })

  test('unmodified, alt-modified, composing, and unrelated keys never zoom', () => {
    expect(fontZoomShortcut(key({ metaKey: false, ctrlKey: false }))).toBeUndefined()
    expect(fontZoomShortcut(key({ altKey: true }))).toBeUndefined()
    expect(fontZoomShortcut(key({ isComposing: true }))).toBeUndefined()
    expect(fontZoomShortcut(key({ key: 'a' }))).toBeUndefined()
    expect(fontZoomShortcut(key({ key: '_' }))).toBeUndefined()
  })

  test('stepping moves all three tiers together by one pixel', () => {
    const next = stepAppearanceFontSizes(DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS, 1)
    expect(next.ui.size).toBe(15)
    expect(next.content.size).toBe(15)
    expect(next.code.size).toBe(13)
    const previous = stepAppearanceFontSizes(DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS, -1)
    expect(previous.ui.size).toBe(13)
    expect(previous.content.size).toBe(13)
    expect(previous.code.size).toBe(11)
  })

  test('stepping preserves each tier family and clamps at the shared range', () => {
    const atBounds = {
      ui: { family: 'geist', size: APPEARANCE_EDITOR_FONT_SIZE_MAX },
      content: { family: 'system', size: APPEARANCE_EDITOR_FONT_SIZE_MIN },
      code: { family: 'geist-mono', size: 20 },
    }
    const up = stepAppearanceFontSizes(atBounds, 1)
    expect(up.ui.size).toBe(APPEARANCE_EDITOR_FONT_SIZE_MAX)
    expect(up.content.size).toBe(APPEARANCE_EDITOR_FONT_SIZE_MIN + 1)
    expect(up.code.size).toBe(21)
    expect(up.ui.family).toBe('geist')
    const down = stepAppearanceFontSizes(atBounds, -1)
    expect(down.ui.size).toBe(APPEARANCE_EDITOR_FONT_SIZE_MAX - 1)
    expect(down.content.size).toBe(APPEARANCE_EDITOR_FONT_SIZE_MIN)
    expect(down.code.family).toBe('geist-mono')
  })

  test('missing or malformed settings recover to the defaults before stepping', () => {
    const next = stepAppearanceFontSizes(undefined, 1)
    expect(next).toEqual({
      ui: { family: 'system', size: 15 },
      content: { family: 'system', size: 15 },
      code: { family: 'system', size: 13 },
    })
    const malformed = stepAppearanceFontSizes({ ui: { size: 'huge' } }, -1)
    expect(malformed.ui).toEqual({ family: 'system', size: 13 })
  })
})
