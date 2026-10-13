import { describe, expect, test } from 'bun:test'

import { createVersionedPersistence, defaultThemeSelection } from '@adea-ai/ui/components/theme'
import { REDUCED_TRANSPARENCY_QUERY } from '@adea-ai/ui/lib/theme-surface'

import {
  adeaV2Codec,
  appearanceDocument,
  appearanceSchema,
  appearanceThemeScript,
  APPEARANCE_ACCENT_CONTRAST_FLOOR,
  APPEARANCE_LIBRARY_STORAGE_KEY,
  APPEARANCE_RECOVERY_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_ACCENT_PRESET_ID,
  defaultAppearancePreferences,
  LEGACY_THEME_STORAGE_KEY,
  migrateLegacyThemeValue,
  normalizeAppearancePreferences,
  preferencesFromSelection,
  selectionFromPreferences,
  type AppearancePreferencesV2,
} from '../src/components/appearance-codec'
import { CUSTOM_THEME_LIBRARY_RECOVERY_KEY } from '../src/components/custom-theme-library'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function envelopeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

function persistenceOver(storage: ReturnType<typeof envelopeStorage> | undefined) {
  return createVersionedPersistence(appearanceSchema, adeaV2Codec, { storage: () => storage })
}

/** The provider's committed selection after it merges what the store read into its defaults. */
function committed(read: ReturnType<ReturnType<typeof persistenceOver>['read']>) {
  return { ...defaultThemeSelection, ...read }
}

function accentOf(accent: unknown): string {
  return normalizeAppearancePreferences({ version: 2, accent }).value.accent
}

describe('preference normalization', () => {
  test('a v2 record round-trips', () => {
    const preferences: AppearancePreferencesV2 = {
      version: 2,
      mode: 'dark',
      lightThemeId: 'nord-light',
      darkThemeId: 'nord',
      // A pin (not just the `'theme'` sentinel) must survive normalization.
      terminalThemeId: 'dracula',
      accent: 'blue',
      surface: 'frosted',
      reduceTransparency: true,
    }
    expect(normalizeAppearancePreferences(JSON.parse(JSON.stringify(preferences))).value).toEqual(
      preferences
    )
  })

  test('unknown versions retain the raw record and fall back to defaults', () => {
    const raw = { version: 3, mode: 'dark', mystery: true }
    const normalized = normalizeAppearancePreferences(raw)
    expect(normalized.value).toEqual(defaultAppearancePreferences)
    expect(normalized.retainedRaw).toEqual(raw)
    expect(normalizeAppearancePreferences('nonsense').retainedRaw).toBe('nonsense')
  })

  test('individual unknown fields inside a v2 record are corrected', () => {
    expect(
      normalizeAppearancePreferences({
        version: 2,
        mode: 'sepia',
        lightThemeId: '',
        darkThemeId: 42,
        terminalThemeId: 42,
        accent: '#zzzzzz',
        surface: 'glass',
        reduceTransparency: 'yes',
      }).value
    ).toEqual(defaultAppearancePreferences)
  })

  test('an unknown theme id is kept for the provider to resolve', () => {
    const { value } = normalizeAppearancePreferences({
      version: 2,
      lightThemeId: 'removed-light',
      darkThemeId: 'removed-dark',
    })
    expect(value.lightThemeId).toBe('removed-light')
    expect(value.darkThemeId).toBe('removed-dark')
  })

  test('accents: presets and theme slots survive, the legacy default migrates', () => {
    expect(accentOf('blue')).toBe('blue')
    expect(accentOf('ansi-cyan')).toBe('ansi-cyan')
    // `'theme'` was the pre-preset default and is no longer pickable.
    expect(accentOf('theme')).toBe(DEFAULT_ACCENT_PRESET_ID)
    expect(accentOf(undefined)).toBe(DEFAULT_ACCENT_PRESET_ID)
    expect(accentOf('#zzzzzz')).toBe(DEFAULT_ACCENT_PRESET_ID)
    expect(accentOf('not-an-accent')).toBe(DEFAULT_ACCENT_PRESET_ID)
  })

  test('accents: a custom colour has one stored spelling, #rrggbb', () => {
    expect(accentOf('#112233')).toBe('#112233')
    expect(accentOf('#ABC')).toBe('#aabbcc')
    // The shared provider reads nothing else, so an alpha channel is dropped.
    expect(accentOf('#11223380')).toBe('#112233')
  })

  test('font settings recover through the shared contract', () => {
    const normalized = normalizeAppearancePreferences({
      ...defaultAppearancePreferences,
      fonts: {
        ui: { family: 'geist', size: 16 },
        content: { family: 'missing-font', size: -2 },
        code: { family: 'jetbrains-mono', size: 18 },
      },
    }).value
    expect(normalized.fonts).toEqual({
      ui: { family: 'geist', size: 16 },
      content: { family: 'system', size: 10 },
      code: { family: 'jetbrains-mono', size: 18 },
    })
    expect(normalizeAppearancePreferences(defaultAppearancePreferences).value).toEqual(
      defaultAppearancePreferences
    )
  })

  test('the legacy theme key maps into v2', () => {
    expect(migrateLegacyThemeValue('dark')).toEqual({
      ...defaultAppearancePreferences,
      mode: 'dark',
    })
    expect(migrateLegacyThemeValue('system')?.mode).toBe('system')
    expect(migrateLegacyThemeValue('nonsense')).toBeUndefined()
    expect(migrateLegacyThemeValue(null)).toBeUndefined()
  })

  test('the contrast floor and storage keys are the ones stored data was written under', () => {
    expect(APPEARANCE_ACCENT_CONTRAST_FLOOR).toBe(3)
    expect(APPEARANCE_STORAGE_KEY).toBe('appearance')
    expect(LEGACY_THEME_STORAGE_KEY).toBe('theme')
    expect(APPEARANCE_RECOVERY_STORAGE_KEY).toBe('appearance.recovery')
    expect(APPEARANCE_LIBRARY_STORAGE_KEY).toBe('appearance.library')
    // The library quarantines into its own key, never the preference's.
    expect(CUSTOM_THEME_LIBRARY_RECOVERY_KEY).toBe('appearance.library.recovery')
    expect(CUSTOM_THEME_LIBRARY_RECOVERY_KEY).not.toBe(APPEARANCE_RECOVERY_STORAGE_KEY)
  })
})

describe('selection and preference mapping', () => {
  test('a preference maps to a selection patch and back', () => {
    const preferences: AppearancePreferencesV2 = {
      version: 2,
      mode: 'light',
      lightThemeId: 'nord-light',
      darkThemeId: 'nord',
      terminalThemeId: 'dracula',
      accent: '#112233',
      surface: 'translucent',
      reduceTransparency: true,
    }
    const selection = selectionFromPreferences(preferences)
    expect(selection).toEqual({
      appearance: 'light',
      lightThemeId: 'nord-light',
      darkThemeId: 'nord',
      terminalThemeId: 'dracula',
      accent: '#112233',
      surface: 'translucent',
      reduceTransparency: true,
    })
    expect(preferencesFromSelection({ ...defaultThemeSelection, ...selection })).toEqual({
      ...preferences,
      fonts: defaultThemeSelection.fonts,
    })
  })

  test('a patch maps only the fields it carries', () => {
    expect(selectionFromPreferences({ surface: 'frosted' })).toEqual({ surface: 'frosted' })
    expect(selectionFromPreferences({})).toEqual({})
  })

  test('the legacy theme accent is the default preset in both directions', () => {
    expect(selectionFromPreferences({ accent: 'theme' }).accent).toBe(DEFAULT_ACCENT_PRESET_ID)
    expect(preferencesFromSelection({ ...defaultThemeSelection, accent: 'theme' }).accent).toBe(
      DEFAULT_ACCENT_PRESET_ID
    )
  })
})

describe('the storage schema', () => {
  test('keeps the keys, version and field name of the stored document', () => {
    expect(appearanceSchema).toEqual({
      key: 'appearance',
      version: 2,
      appearanceField: 'mode',
      legacyAppearanceKey: 'theme',
      libraryKey: 'appearance.library',
      recoveryKey: 'appearance.recovery',
    })
  })
})

describe('persistence over the V2 document', () => {
  test('reads the v2 key, then the legacy key, then the install defaults', () => {
    expect(
      persistenceOver(
        envelopeStorage({
          [APPEARANCE_STORAGE_KEY]: JSON.stringify({ version: 2, mode: 'dark' }),
        })
      ).read()?.appearance
    ).toBe('dark')
    expect(
      persistenceOver(envelopeStorage({ [LEGACY_THEME_STORAGE_KEY]: 'light' })).read()
    ).toEqual(selectionFromPreferences({ ...defaultAppearancePreferences, mode: 'light' }))
    // A fresh install keeps the codec's violet accent, which the provider's own
    // default (the theme's primary) would not.
    expect(
      persistenceOver(envelopeStorage({ [LEGACY_THEME_STORAGE_KEY]: 'bogus' })).read()
    ).toEqual(selectionFromPreferences(defaultAppearancePreferences))
    expect(persistenceOver(envelopeStorage()).read()?.accent).toBe('violet')
  })

  test('the legacy key is read only while the main key is absent', () => {
    const corrupt = persistenceOver(
      envelopeStorage({ [APPEARANCE_STORAGE_KEY]: '{nope', [LEGACY_THEME_STORAGE_KEY]: 'dark' })
    )
    // A present-but-unreadable main record does not fall through to the old key.
    expect(corrupt.read()?.appearance).toBe('system')
    const empty = persistenceOver(
      envelopeStorage({ [APPEARANCE_STORAGE_KEY]: '', [LEGACY_THEME_STORAGE_KEY]: 'dark' })
    )
    expect(empty.read()?.appearance).toBe('system')
    const valid = persistenceOver(
      envelopeStorage({
        [APPEARANCE_STORAGE_KEY]: JSON.stringify({ version: 2, mode: 'light' }),
        [LEGACY_THEME_STORAGE_KEY]: 'dark',
      })
    )
    expect(valid.read()?.appearance).toBe('light')
  })

  test('a blocked storage API degrades to the defaults and never throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const persistence = createVersionedPersistence(appearanceSchema, adeaV2Codec, {
      storage: () => blocked,
    })
    expect(persistence.read()).toEqual(selectionFromPreferences(defaultAppearancePreferences))
    expect(() => persistence.write(defaultThemeSelection)).not.toThrow()
    expect(persistenceOver(undefined).read()).toEqual(
      selectionFromPreferences(defaultAppearancePreferences)
    )
  })

  test('a corrupt JSON value is quarantined and survives a later valid write byte for byte', () => {
    const corrupt = '{"version":2,"mode":"da'
    const storage = envelopeStorage({ [APPEARANCE_STORAGE_KEY]: corrupt })
    const persistence = persistenceOver(storage)
    expect(persistence.read()).toEqual(selectionFromPreferences(defaultAppearancePreferences))
    const envelope = JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!) as {
      schemaVersion: number
      reason: string
      raw: string
      capturedAt: string
    }
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.reason).toBe('corrupt_json')
    expect(envelope.raw).toBe(corrupt)
    expect(Number.isNaN(Date.parse(envelope.capturedAt))).toBe(false)
    // Saving valid preferences must not destroy the unread original.
    persistence.write({ ...defaultThemeSelection, appearance: 'dark' })
    expect(JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!).raw).toBe(corrupt)
    expect(persistence.read()?.appearance).toBe('dark')
  })

  test('a future-version record is quarantined and survives a later valid write', () => {
    const future = JSON.stringify({ version: 3, mode: 'sepia', nextThing: true })
    const storage = envelopeStorage({ [APPEARANCE_STORAGE_KEY]: future })
    const persistence = persistenceOver(storage)
    expect(persistence.read()).toEqual(selectionFromPreferences(defaultAppearancePreferences))
    const envelope = JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!) as {
      reason: string
      raw: string
    }
    expect(envelope.reason).toBe('unsupported_record')
    expect(envelope.raw).toBe(future)
    persistence.write(defaultThemeSelection)
    expect(JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!).raw).toBe(future)
  })

  test('a quarantine is idempotent across repeated reads', () => {
    const corrupt = 'not-json-at-all'
    const storage = envelopeStorage({ [APPEARANCE_STORAGE_KEY]: corrupt })
    const persistence = persistenceOver(storage)
    persistence.read()
    persistence.read()
    expect(JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!).raw).toBe(corrupt)
  })

  test('a valid v2 write and read round-trips and never creates a recovery envelope', () => {
    const storage = envelopeStorage()
    const persistence = persistenceOver(storage)
    const preferences: AppearancePreferencesV2 = {
      version: 2,
      mode: 'light',
      lightThemeId: 'adea-light-high-contrast',
      darkThemeId: 'adea-dark-high-contrast',
      terminalThemeId: 'theme',
      accent: '#112233',
      surface: 'translucent',
      reduceTransparency: true,
    }
    persistence.write(committed(selectionFromPreferences(preferences)))
    expect(preferencesFromSelection(committed(persistence.read())).accent).toBe('#112233')
    expect({
      ...preferencesFromSelection(committed(persistence.read())),
      fonts: undefined,
    }).toEqual({ ...preferences, fonts: undefined })
    expect(storage.store.has(APPEARANCE_RECOVERY_STORAGE_KEY)).toBeFalse()
  })

  test('the legacy theme key migrates without deletion and writes no envelope', () => {
    const storage = envelopeStorage({ [LEGACY_THEME_STORAGE_KEY]: 'dark' })
    const persistence = persistenceOver(storage)
    expect(persistence.read()?.appearance).toBe('dark')
    expect(storage.store.get(LEGACY_THEME_STORAGE_KEY)).toBe('dark')
    expect(storage.store.has(APPEARANCE_RECOVERY_STORAGE_KEY)).toBeFalse()
    // A later write lands in the v2 key; the legacy key stays untouched.
    persistence.write({ ...defaultThemeSelection, appearance: 'dark', surface: 'frosted' })
    expect(storage.store.get(LEGACY_THEME_STORAGE_KEY)).toBe('dark')
    expect(JSON.parse(storage.store.get(APPEARANCE_STORAGE_KEY)!).surface).toBe('frosted')
  })

  test('the document is written with exactly the stored bytes', () => {
    const storage = envelopeStorage()
    const persistence = persistenceOver(storage)
    persistence.read()
    persistence.write(committed(persistence.read()))
    expect(storage.store.get(APPEARANCE_STORAGE_KEY)).toBe(
      '{"version":2,"mode":"system","lightThemeId":"adea-light","darkThemeId":"adea-dark","terminalThemeId":"theme","accent":"violet","surface":"opaque","reduceTransparency":false}'
    )
  })

  test('a stored document survives a read and rewrite unchanged', () => {
    const documents = [
      // Written before text settings existed: no `fonts` key, and none is added.
      '{"version":2,"mode":"dark","lightThemeId":"nord-light","darkThemeId":"nord","terminalThemeId":"dracula","accent":"blue","surface":"frosted","reduceTransparency":true}',
      '{"version":2,"mode":"light","lightThemeId":"adea-light","darkThemeId":"adea-dark","terminalThemeId":"theme","accent":"#112233","surface":"opaque","reduceTransparency":false}',
      // A document that carries text settings keeps them, even at the defaults.
      '{"version":2,"mode":"system","lightThemeId":"adea-light","darkThemeId":"adea-dark","terminalThemeId":"theme","accent":"violet","surface":"opaque","reduceTransparency":false,"fonts":{"ui":{"family":"system","size":14},"content":{"family":"system","size":14},"code":{"family":"system","size":13}}}',
    ]
    for (const stored of documents) {
      const storage = envelopeStorage({ [APPEARANCE_STORAGE_KEY]: stored })
      const persistence = persistenceOver(storage)
      const selection = committed(persistence.read())
      persistence.write(selection)
      const rewritten = JSON.parse(storage.store.get(APPEARANCE_STORAGE_KEY)!)
      const original = JSON.parse(stored)
      // The field set and the values are the ones that were stored.
      expect(Object.keys(rewritten)).toEqual(
        Object.keys(original)
          .filter((k) => k !== 'fonts')
          .concat('fonts' in original ? ['fonts'] : [])
      )
      expect({ ...rewritten, fonts: undefined }).toEqual({ ...original, fonts: undefined })
    }
  })

  test('text settings are written once they differ from the defaults', () => {
    const fonts = {
      ui: { family: 'geist', size: 16 },
      content: { family: 'system', size: 14 },
      code: { family: 'system', size: 13 },
    } as const
    const document = appearanceDocument({ ...defaultThemeSelection, fonts, font: 'geist' })
    expect(document.fonts).toEqual(fonts)
    expect(Object.keys(document).at(-1)).toBe('fonts')
    expect('fonts' in appearanceDocument(defaultThemeSelection)).toBe(false)
    // A record that carried them keeps carrying them.
    expect('fonts' in appearanceDocument(defaultThemeSelection, { version: 2, fonts: {} })).toBe(
      true
    )
  })
})

function datasetKey(attribute: string): string {
  return attribute.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function fakeDocument() {
  const style: Record<string, string> = {}
  const dataset: Record<string, string> = {}
  const classes = new Set<string>()
  const document = {
    documentElement: {
      style: {
        colorScheme: '',
        setProperty: (name: string, value: string) => void (style[name] = value),
        removeProperty: (name: string) => void delete style[name],
      },
      dataset,
      setAttribute: (name: string, value: string) => void (dataset[datasetKey(name)] = value),
      removeAttribute: (name: string) => void delete dataset[datasetKey(name)],
      classList: {
        add: (name: string) => void classes.add(name),
        remove: (name: string) => void classes.delete(name),
        toggle: (name: string, force?: boolean) => {
          if (force ?? !classes.has(name)) classes.add(name)
          else classes.delete(name)
        },
      },
    },
  }
  return { document, style, dataset, classes }
}

function runScript(storage: Record<string, string>, systemDark = false, osReduce = false) {
  const { document, style, dataset, classes } = fakeDocument()
  const window = {
    matchMedia: (query: string) => ({
      matches:
        query === DARK_QUERY ? systemDark : query === REDUCED_TRANSPARENCY_QUERY ? osReduce : false,
    }),
  }
  new Function('window', 'document', 'localStorage', appearanceThemeScript())(
    window,
    document,
    envelopeStorage(storage)
  )
  return { style, dataset, classes }
}

describe('the no-flash preload script', () => {
  test('is built from the same schema the persistence reads', () => {
    const script = appearanceThemeScript()
    for (const key of ['appearance', 'theme', 'appearance.library']) {
      expect(script).toContain(JSON.stringify(key))
    }
    expect(script).toContain('x.version===2')
    expect(script).toContain('doc["mode"]')
  })

  test('a stored v2 preference restores the document before first paint', () => {
    const { dataset, classes, style } = runScript({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({
        version: 2,
        mode: 'dark',
        lightThemeId: 'adea-light',
        darkThemeId: 'nord',
        accent: 'blue',
        surface: 'frosted',
      }),
    })
    expect(classes.has('dark')).toBe(true)
    // The palette is stylesheet-owned: the resolved `data-theme` selects its block.
    expect(dataset.theme).toBe('nord')
    expect(dataset.appearance).toBe('dark')
    expect(dataset.accent).toBe('blue')
    expect(dataset.surface).toBe('frosted')
    expect(dataset.reduceTransparency).toBe('false')
    expect(style['--surface-alpha']).toBeDefined()
    expect(Object.keys(style).filter((name) => name.startsWith('--background'))).toEqual([])
  })

  test('the accent attribute follows the shared vocabulary', () => {
    const scriptAccent = (accent: string | undefined) =>
      runScript({
        [APPEARANCE_STORAGE_KEY]: JSON.stringify({ version: 2, ...(accent ? { accent } : {}) }),
      }).dataset.accent
    expect(scriptAccent('violet')).toBe('violet')
    // A custom colour has no stylesheet block: the attribute reports `custom`.
    expect(scriptAccent('#112233')).toBe('custom')
    // A theme-derived accent is painted by the provider once it mounts.
    expect(scriptAccent('ansi-blue')).toBeUndefined()
    // The pre-preset default and a missing accent paint the install default.
    expect(scriptAccent('theme')).toBe('violet')
    expect(scriptAccent(undefined)).toBe('violet')
    expect(runScript({}).dataset.accent).toBe('violet')
  })

  test('the legacy theme key migrates with no flash and is never deleted', () => {
    const { dataset, classes } = runScript({ [LEGACY_THEME_STORAGE_KEY]: 'dark' })
    expect(classes.has('dark')).toBe(true)
    expect(dataset.theme).toBe('adea-dark')
  })

  test('no stored preference resolves the system palette', () => {
    expect(runScript({}, false).classes.has('dark')).toBe(false)
    expect(runScript({}, true).classes.has('dark')).toBe(true)
  })

  test('unknown stored theme ids pre-paint the default for the resolved appearance', () => {
    for (const mode of ['light', 'dark'] as const) {
      const { dataset } = runScript({
        [APPEARANCE_STORAGE_KEY]: JSON.stringify({
          version: 2,
          mode,
          lightThemeId: 'removed-light-theme',
          darkThemeId: 'removed-dark-theme',
        }),
      })
      expect(dataset.theme).toBe(mode === 'dark' ? 'adea-dark' : 'adea-light')
    }
  })

  test('an imported theme pre-paints its stored flat tokens', () => {
    const { dataset, style } = runScript({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({
        version: 2,
        mode: 'dark',
        darkThemeId: 'custom-mine',
      }),
      [APPEARANCE_LIBRARY_STORAGE_KEY]: JSON.stringify({
        version: 1,
        themes: [{ id: 'custom-mine', flatTokens: { '--background': '#010203', x: 'ignored' } }],
      }),
    })
    expect(dataset.theme).toBe('custom-mine')
    expect(style['--background']).toBe('#010203')
    expect(style.x).toBeUndefined()
  })

  test('reduced transparency pre-paints the opaque surface', () => {
    const stored = {
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({ version: 2, surface: 'translucent' }),
    }
    expect(runScript(stored, false, true).dataset.surface).toBe('opaque')
    expect(runScript(stored).dataset.surface).toBe('frosted')
    expect(
      runScript({
        [APPEARANCE_STORAGE_KEY]: JSON.stringify({
          version: 2,
          surface: 'translucent',
          reduceTransparency: true,
        }),
      }).dataset.surface
    ).toBe('opaque')
  })

  test('saved text settings are projected before first paint', () => {
    const { style, dataset } = runScript({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({
        ...defaultAppearancePreferences,
        fonts: {
          ui: { family: 'geist', size: 16 },
          content: { family: 'space-grotesk', size: 18 },
          code: { family: 'jetbrains-mono', size: 13 },
        },
      }),
    })
    expect(dataset.uiFont).toBe('geist')
    expect(style['--font-ui-size']).toBe('16px')
  })

  test('an unsupported preference version cannot project saved font overrides', () => {
    const { style, dataset } = runScript({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({
        version: 99,
        fonts: { ui: { family: 'geist', size: 32 } },
      }),
    })
    expect(dataset.uiFont).toBeUndefined()
    expect(style['--font-ui-size']).toBe('14px')
  })

  test('corrupt stored data degrades to the defaults instead of throwing', () => {
    expect(runScript({ [APPEARANCE_STORAGE_KEY]: '{not json' }).dataset.theme).toBe('adea-light')
  })
})
