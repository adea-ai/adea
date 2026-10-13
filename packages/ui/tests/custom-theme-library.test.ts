import { afterEach, describe, expect, test } from 'bun:test'

import { themeCssVariables } from '@adea-ai/ui/lib/themes'

import {
  APPEARANCE_RECOVERY_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY,
} from '../src/components/appearance-codec'
import {
  CUSTOM_THEME_LIBRARY_RECOVERY_KEY,
  CUSTOM_THEME_LIBRARY_STORAGE_KEY,
  customThemeVariants,
  customUiVariants,
  flatVariantTokens,
  readCustomThemeLibrary,
  removeCustomTheme,
  setCustomThemes,
  storedVariantRecord,
  subscribeCustomThemes,
  toUiVariant,
  validateThemeRegistry,
} from '../src/components/custom-theme-library'
import { ANSI, stored, storedVariant } from './support/stored-theme'
import { themeRegistry } from '../src/components/theme-registry'

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

const variant = storedVariant

afterEach(() => setCustomThemes([], undefined))

describe('flat token map', () => {
  test('names every custom property an imported theme owns', () => {
    const tokens = flatVariantTokens(variant('custom-a'))
    expect(tokens['--background']).toBe('#1e2127')
    expect(tokens['--card-foreground']).toBe('#d7dae0')
    expect(tokens['--destructive-action-foreground']).toBe('#10161d')
    expect(tokens['--terminal-background']).toBe('#1e2127')
    expect(tokens['--terminal-ansi-black']).toBe('#000000')
    expect(tokens['--terminal-ansi-bright-cyan']).toBe('#6fd0dc')
    expect(tokens['--editor-diff-add']).toBe('#98c379')
    expect(tokens['--editor-search-match']).toBe('#e5c07b')
    expect(tokens['--chart-1']).toBe('#61afef')
    expect(tokens['--chart-6']).toBe('#e06c75')
    expect(Object.keys(tokens)).toHaveLength(21 + 4 + 16 + 16 + 6)
  })
})

describe('shared variant for a stored theme', () => {
  test('keeps the stored identity and paints the stored tokens verbatim', () => {
    const theme = stored('custom-a')
    const shared = toUiVariant(theme)
    expect(shared.id).toBe('custom-a')
    expect(shared.appearance).toBe('dark')
    // What was imported is what is painted: the stored map wins over every derivation.
    expect(shared.tokens).toEqual(theme.flatTokens)
    const painted = { ...themeCssVariables(shared), ...shared.tokens }
    for (const [name, value] of Object.entries(theme.flatTokens)) {
      expect(painted[name]).toBe(value)
    }
  })

  test('the editor record is reconstructed from the stored roles', () => {
    const record = storedVariantRecord(variant('custom-a'))
    expect(record.id).toBe('custom-a')
    expect(record.colors.surface).toBe('#262a31')
    expect(record.colors.accent).toBe('#61afef')
    expect(record.colors.warning).toBe(ANSI[3])
    expect(record.colors.info).toBe(ANSI[4])
    expect(record.label).toBe('Theme custom-a')
    expect(record.description).toBe('Theme custom-a, imported into your library.')
    expect(record.tags).toEqual(['imported', 'dark'])
  })
})

describe('registry validation', () => {
  test('a readable theme has no errors', () => {
    expect(validateThemeRegistry([variant('custom-a')])).toEqual([])
  })

  test('unreadable text, a duplicate id and a weak accent are errors', () => {
    const weak = variant('custom-a')
    const issues = validateThemeRegistry([
      { ...weak, colors: { ...weak.colors, foreground: weak.colors.background } },
      weak,
    ])
    expect(issues.some((issue) => issue.message.startsWith('text contrast'))).toBe(true)
    expect(issues.some((issue) => issue.message === 'variant id must be unique')).toBe(true)
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true)
  })

  test('a weak chromatic terminal slot is a warning, not an error', () => {
    const weak = variant('custom-a')
    const ansi = [...weak.terminal.ansi]
    ansi[1] = weak.terminal.background
    const issues = validateThemeRegistry([{ ...weak, terminal: { ...weak.terminal, ansi } }])
    expect(issues).toEqual([
      { variantId: 'custom-a', severity: 'warning', message: 'terminal ANSI slot 1 is below 3:1' },
    ])
  })
})

describe('the in-memory library', () => {
  test('imported themes join the catalogue after it', () => {
    const before = themeRegistry().length
    setCustomThemes([stored('custom-a'), stored('custom-b', 'light')], undefined)
    const registry = themeRegistry()
    expect(registry).toHaveLength(before + 2)
    expect(registry.slice(-2).map((entry) => entry.id)).toEqual(['custom-a', 'custom-b'])
    expect(customThemeVariants().map((entry) => entry.id)).toEqual(['custom-a', 'custom-b'])
    expect(customUiVariants().map((entry) => entry.appearance)).toEqual(['dark', 'light'])
  })

  test('an id outside the custom namespace is namespaced on the way in', () => {
    setCustomThemes([stored('adea-dark')], undefined)
    expect(customUiVariants().map((entry) => entry.id)).toEqual(['custom-adea-dark'])
    expect(themeRegistry().filter((entry) => entry.id === 'adea-dark')).toHaveLength(1)
  })

  test('subscribers hear a change made through any instance', () => {
    let heard = 0
    const stop = subscribeCustomThemes(() => (heard += 1))
    setCustomThemes([stored('custom-a')], undefined)
    removeCustomTheme('custom-a', undefined)
    stop()
    setCustomThemes([stored('custom-b')], undefined)
    expect(heard).toBe(2)
  })

  test('removing a theme persists the rest', () => {
    const storage = memoryStorage()
    setCustomThemes([stored('custom-a'), stored('custom-b')], storage)
    removeCustomTheme('custom-a', storage)
    expect(JSON.parse(storage.store.get(CUSTOM_THEME_LIBRARY_STORAGE_KEY)!).themes).toHaveLength(1)
    expect(customThemeVariants().map((entry) => entry.id)).toEqual(['custom-b'])
  })
})

describe('stored library', () => {
  test('is written as version 1 with the themes as imported', () => {
    const storage = memoryStorage()
    const theme = stored('custom-a')
    setCustomThemes([theme], storage)
    const document = JSON.parse(storage.store.get(CUSTOM_THEME_LIBRARY_STORAGE_KEY)!)
    expect(Object.keys(document)).toEqual(['version', 'themes'])
    expect(document.version).toBe(1)
    expect(document.themes).toEqual([JSON.parse(JSON.stringify(theme))])
  })

  test('round-trips through a read', () => {
    const storage = memoryStorage()
    setCustomThemes([stored('custom-a'), stored('custom-b', 'light')], storage)
    setCustomThemes([], undefined)
    const read = readCustomThemeLibrary(storage)
    expect(read.map((entry) => entry.id)).toEqual(['custom-a', 'custom-b'])
    expect(customUiVariants().map((entry) => entry.id)).toEqual(['custom-a', 'custom-b'])
  })

  test('a library written by an earlier build still resolves', () => {
    const storage = memoryStorage({
      [CUSTOM_THEME_LIBRARY_STORAGE_KEY]: JSON.stringify({
        version: 1,
        themes: [stored('custom-old')],
      }),
    })
    expect(readCustomThemeLibrary(storage)).toHaveLength(1)
    expect(themeRegistry().at(-1)?.id).toBe('custom-old')
    expect(storage.store.has(CUSTOM_THEME_LIBRARY_RECOVERY_KEY)).toBe(false)
  })

  test('no value and an empty value are no library, not a corrupt one', () => {
    const storage = memoryStorage()
    expect(readCustomThemeLibrary(storage)).toEqual([])
    storage.store.set(CUSTOM_THEME_LIBRARY_STORAGE_KEY, '')
    expect(readCustomThemeLibrary(storage)).toEqual([])
    expect(readCustomThemeLibrary(undefined)).toEqual([])
    expect(storage.store.has(CUSTOM_THEME_LIBRARY_RECOVERY_KEY)).toBe(false)
  })

  test('an invalid entry is dropped, not fatal', () => {
    const storage = memoryStorage({
      [CUSTOM_THEME_LIBRARY_STORAGE_KEY]: JSON.stringify({
        version: 1,
        themes: [stored('custom-a'), { id: 'custom-broken' }, null, 'text'],
      }),
    })
    expect(readCustomThemeLibrary(storage).map((entry) => entry.id)).toEqual(['custom-a'])
    expect(storage.store.has(CUSTOM_THEME_LIBRARY_RECOVERY_KEY)).toBe(false)
  })

  test('corrupt bytes are quarantined into the library own key, byte for byte', () => {
    const corrupt = '{"version":1,"themes":[{"id":"cus'
    const storage = memoryStorage({ [CUSTOM_THEME_LIBRARY_STORAGE_KEY]: corrupt })
    expect(readCustomThemeLibrary(storage)).toEqual([])
    const envelope = JSON.parse(storage.store.get(CUSTOM_THEME_LIBRARY_RECOVERY_KEY)!)
    expect(envelope).toMatchObject({ schemaVersion: 1, reason: 'corrupt_json', raw: corrupt })
    // Reading again keeps the same capture.
    readCustomThemeLibrary(storage)
    expect(JSON.parse(storage.store.get(CUSTOM_THEME_LIBRARY_RECOVERY_KEY)!).raw).toBe(corrupt)
  })

  test('an unsupported record is quarantined with its reason', () => {
    for (const raw of [
      JSON.stringify({ version: 2, themes: [] }),
      JSON.stringify({ version: 1, themes: 'nope' }),
      JSON.stringify([]),
    ]) {
      const storage = memoryStorage({ [CUSTOM_THEME_LIBRARY_STORAGE_KEY]: raw })
      expect(readCustomThemeLibrary(storage)).toEqual([])
      expect(JSON.parse(storage.store.get(CUSTOM_THEME_LIBRARY_RECOVERY_KEY)!)).toMatchObject({
        reason: 'unsupported_record',
        raw,
      })
    }
  })

  test('the library and the preference quarantine independently', () => {
    const preference = '{"version":2,"mode":"da'
    const library = '{"version":1,"themes":['
    const storage = memoryStorage({
      [APPEARANCE_STORAGE_KEY]: preference,
      [APPEARANCE_RECOVERY_STORAGE_KEY]: JSON.stringify({
        schemaVersion: 1,
        reason: 'corrupt_json',
        capturedAt: '2026-10-01T00:00:00.000Z',
        raw: preference,
      }),
      [CUSTOM_THEME_LIBRARY_STORAGE_KEY]: library,
    })
    readCustomThemeLibrary(storage)
    // The preference's capture is not overwritten by the library's.
    expect(JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!).raw).toBe(preference)
    expect(JSON.parse(storage.store.get(CUSTOM_THEME_LIBRARY_RECOVERY_KEY)!).raw).toBe(library)
  })

  test('blocked storage never throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readCustomThemeLibrary(blocked)).toEqual([])
    expect(() => setCustomThemes([stored('custom-a')], blocked)).not.toThrow()
    expect(customThemeVariants()).toHaveLength(1)
  })
})
