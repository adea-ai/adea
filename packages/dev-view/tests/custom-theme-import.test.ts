import { afterEach, describe, expect, test } from 'bun:test'

import {
  CUSTOM_THEME_LIBRARY_STORAGE_KEY,
  removeCustomTheme,
  setCustomThemes,
  themeRegistry,
  type CustomThemeStored,
} from '@adea-ai/app-ui/components/appearance'
import { importCustomTheme } from '../src/appearance/custom-theme-import'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: () => null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

const canonicalFile = {
  name: 'Paper Rose',
  appearance: 'light',
  colors: {
    background: '#faf7f5',
    foreground: '#40342f',
    surface: '#f3edeb',
    surfaceElevated: '#ffffff',
    surfaceHover: '#efe6e3',
    surfaceActive: '#e6d9d5',
    border: '#d8c8c3',
    borderMuted: '#e4d8d4',
    text: '#40342f',
    textMuted: '#7a6a63',
    textSubtle: '#6f625b',
    accent: '#b0326b',
    accentForeground: '#ffffff',
    success: '#1f7a3d',
    warning: '#9a6700',
    error: '#c22f2f',
    info: '#2264c2',
  },
  ansi: {
    black: '#3b3330',
    red: '#c22f2f',
    green: '#1f7a3d',
    yellow: '#9a6700',
    blue: '#2264c2',
    magenta: '#b0326b',
    cyan: '#0f7a80',
    white: '#8f817b',
    brightBlack: '#5f524c',
    brightRed: '#e05252',
    brightGreen: '#3da35f',
    brightYellow: '#c78f1f',
    brightBlue: '#4b87e0',
    brightMagenta: '#d05a8d',
    brightCyan: '#31a0a8',
    brightWhite: '#c4b8b2',
  },
  cursor: '#b0326b',
  selection: '#f0dde5',
}

let storage: Storage = memoryStorage()
afterEach(() => {
  setCustomThemes([], storage)
  storage = memoryStorage()
})

describe('custom theme import', () => {
  test('imports a canonical file into the registry and persists it', () => {
    const result = importCustomTheme(JSON.stringify(canonicalFile), storage, [])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.theme.id.startsWith('custom-')).toBe(true)
    expect(result.theme.appearance).toBe('light')
    expect(result.theme.notes).toEqual([])
    expect(themeRegistry().some((variant) => variant.id === result.theme.id)).toBe(true)
    expect(result.theme.flatTokens['--background']).toBe('#faf7f5')
    const persisted = JSON.parse(storage.getItem(CUSTOM_THEME_LIBRARY_STORAGE_KEY)!)
    expect(persisted.version).toBe(1)
    expect(persisted.themes).toHaveLength(1)
  })

  test('fills missing roles from the same-appearance default and says so', () => {
    const result = importCustomTheme(
      JSON.stringify({
        name: 'Mostly Default',
        appearance: 'dark',
        colors: { background: '#101418', foreground: '#dbe4ee' },
      }),
      storage,
      []
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.theme.notes.join(' ')).toContain('Missing roles were filled')
    expect(result.theme.flatTokens['--background']).toBe('#101418')
  })

  test('repairs unreadable text instead of shipping it', () => {
    const result = importCustomTheme(
      JSON.stringify({
        name: 'Low Contrast',
        appearance: 'dark',
        colors: { background: '#101418', foreground: '#1a2028' },
      }),
      storage,
      []
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.theme.notes.join(' ')).toContain('readable contrast')
    const text = result.theme.variant.colors.foreground
    expect(text.toLowerCase()).not.toBe('#1a2028')
  })

  test('rejects unparseable files without touching the library', () => {
    const result = importCustomTheme('{not json', storage, [])
    expect(result).toEqual({ ok: false, error: 'That file is not valid JSON.' })
    expect(themeRegistry().some((variant) => variant.id.startsWith('custom-'))).toBe(false)
  })

  test('removal drops the theme from the registry and storage', () => {
    const result = importCustomTheme(JSON.stringify(canonicalFile), storage, [])
    expect(result.ok).toBe(true)
    const stored: CustomThemeStored = result.ok ? result.theme : (undefined as never)
    removeCustomTheme(stored.id, storage)
    expect(themeRegistry().some((variant) => variant.id === stored.id)).toBe(false)
    const persisted = JSON.parse(storage.getItem(CUSTOM_THEME_LIBRARY_STORAGE_KEY)!)
    expect(persisted.themes).toHaveLength(0)
  })
})
