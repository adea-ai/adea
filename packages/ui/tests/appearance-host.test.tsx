import { afterEach, describe, expect, test } from 'bun:test'
import { createRoot } from 'solid-js'

import {
  createVersionedPersistence,
  ThemeProvider,
  useTheme,
  type ThemeContextValue,
} from '@adea-ai/ui/components/theme/lazy'

import { adeaV2Codec, appearanceSchema } from '../src/components/appearance-codec'
import { appearanceProviderProps, createAppearanceContext } from '../src/components/appearance-host'
import { setCustomThemes } from '../src/components/custom-theme-library'
import { stored } from './support/stored-theme'

// The shell runs the shared provider from its lazy entry (ADR 0014): the 34-theme
// catalogue loads in a chunk of its own once a selection or a preview names a theme
// beyond the default pair. These tests mount that real provider with Adea's host
// configuration over an in-memory store. The document is the provider's own and is
// covered by its tests and by the appearance e2e specs; here the question is what
// the context answers, and that the stored bytes never move.

const document2 = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    version: 2,
    mode: 'dark',
    lightThemeId: 'adea-light',
    darkThemeId: 'adea-dark',
    terminalThemeId: 'theme',
    accent: 'violet',
    surface: 'opaque',
    reduceTransparency: false,
    ...overrides,
  })

function memoryStorage(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial))
  const writes: string[] = []
  return {
    store,
    writes,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      writes.push(key)
      store.set(key, value)
    },
  }
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  setCustomThemes([], undefined)
})

function mount(storage: ReturnType<typeof memoryStorage>): ThemeContextValue {
  let context!: ThemeContextValue
  createRoot((rootDispose) => {
    dispose = rootDispose
    ThemeProvider({
      ...appearanceProviderProps(),
      persistence: createVersionedPersistence(appearanceSchema, adeaV2Codec, {
        storage: () => storage,
      }),
      get children() {
        context = useTheme()
        return null
      },
    })
  })
  return context
}

const settle = async (check: () => boolean) => {
  for (let hop = 0; hop < 50 && !check(); hop += 1) await new Promise((r) => setTimeout(r, 0))
}

// Order matters: the catalogue is one import per page, shared by every provider, so
// the tests that need it unloaded run before the first one that loads it.
describe('the shell provider with the catalogue out of start-up', () => {
  test('the default pair never asks for the catalogue', async () => {
    const theme = mount(memoryStorage({ appearance: document2({}) }))
    await settle(() => false)
    expect(theme.catalogueReady?.()).toBe(false)
    expect(theme.variant().id).toBe('adea-dark')
    expect(theme.themes.map((entry) => entry.id).toSorted()).toEqual(['adea-dark', 'adea-light'])
  })

  test('an imported theme resolves at once, from the library, without the catalogue', () => {
    const storage = memoryStorage({})
    setCustomThemes([stored('custom-a')], storage)
    storage.writes.length = 0
    storage.store.set('appearance', document2({ darkThemeId: 'custom-a' }))
    const theme = mount(storage)
    expect(theme.catalogueReady?.()).toBe(false)
    expect(theme.variant().id).toBe('custom-a')
    expect(theme.variant().tokens).toEqual(stored('custom-a').flatTokens)
    expect(theme.allThemes().some((entry) => entry.id === 'custom-a')).toBe(true)
    expect(storage.writes).toEqual([])
  })

  test('a saved catalogue theme keeps the default of its appearance until the catalogue arrives', async () => {
    const saved = document2({ darkThemeId: 'catppuccin-mocha', lightThemeId: 'rosepine-dawn' })
    const storage = memoryStorage({ appearance: saved })
    const theme = mount(storage)
    expect(theme.catalogueReady?.()).toBe(false)
    expect(theme.selection().darkThemeId).toBe('catppuccin-mocha')
    expect(theme.variant().id).toBe('adea-dark')
    expect(theme.themes).toHaveLength(2)

    await settle(() => theme.catalogueReady?.() === true)
    expect(theme.catalogueReady?.()).toBe(true)
    expect(theme.variant().id).toBe('catppuccin-mocha')
    expect(theme.themes).toHaveLength(34)
    // The stored document was only read: no write, not even an identical one.
    expect(storage.writes).toEqual([])
    expect(storage.store.get('appearance')).toBe(saved)
  })

  test('loadCatalogue is idempotent and a provider created afterwards starts loaded', async () => {
    const first = mount(memoryStorage({ appearance: document2({}) }))
    await first.loadCatalogue?.()
    await first.loadCatalogue?.()
    expect(first.catalogueReady?.()).toBe(true)
    expect(first.themes).toHaveLength(34)
    dispose?.()
    const second = mount(memoryStorage({ appearance: document2({}) }))
    expect(second.catalogueReady?.()).toBe(true)
  })

  test('a draft of a catalogue theme previews once loaded and the commit stays untouched', async () => {
    const saved = document2({})
    const storage = memoryStorage({ appearance: saved })
    const appearance = (() => {
      let value!: ReturnType<typeof createAppearanceContext>
      createRoot((rootDispose) => {
        dispose = rootDispose
        ThemeProvider({
          ...appearanceProviderProps(),
          persistence: createVersionedPersistence(appearanceSchema, adeaV2Codec, {
            storage: () => storage,
          }),
          get children() {
            value = createAppearanceContext(useTheme())
            return null
          },
        })
      })
      return value
    })()
    await appearance.loadCatalogue?.()
    appearance.preview({
      version: 2,
      mode: 'dark',
      lightThemeId: 'adea-light',
      darkThemeId: 'dracula',
      terminalThemeId: 'theme',
      accent: 'violet',
      surface: 'opaque',
      reduceTransparency: false,
    })
    expect(appearance.previewing()).toBe(true)
    expect(appearance.selection().darkThemeId).toBe('adea-dark')
    appearance.preview(undefined)
    expect(appearance.previewing()).toBe(false)
    expect(storage.writes).toEqual([])
    expect(storage.store.get('appearance')).toBe(saved)
  })
})
