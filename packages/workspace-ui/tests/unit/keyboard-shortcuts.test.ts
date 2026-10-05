import { describe, expect, test } from 'bun:test'

import { platformModifierKey, settingsShortcutLabel } from '../../src/keyboard-shortcuts'

describe('keyboard shortcut labels', () => {
  test('the modifier glyph follows the operating system, not the build host', () => {
    expect(platformModifierKey('MacIntel')).toBe('⌘')
    expect(platformModifierKey('iPhone')).toBe('⌘')
    expect(platformModifierKey('iPod')).toBe('⌘')
    expect(platformModifierKey('Win32')).toBe('Ctrl')
    expect(platformModifierKey('Linux x86_64')).toBe('Ctrl')
  })

  test('an absent platform string falls back to the spelled-out modifier', () => {
    // Server renders and test environments without a navigator see no Apple
    // platform string, so they advertise Ctrl until a client corrects it.
    expect(platformModifierKey('')).toBe('Ctrl')
  })

  test('the settings chord pairs the platform modifier with a comma', () => {
    expect(settingsShortcutLabel('MacIntel')).toBe('⌘,')
    expect(settingsShortcutLabel('Win32')).toBe('Ctrl,')
    expect(settingsShortcutLabel()).toBe(`${platformModifierKey()},`)
  })
})
