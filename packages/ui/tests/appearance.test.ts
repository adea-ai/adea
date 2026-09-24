import { describe, expect, test } from 'bun:test'

import {
  accentPresets,
  APPEARANCE_RECOVERY_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY,
  applyAppearanceToDocument,
  appearanceThemeScript,
  builtinThemeRegistry,
  colorToHex,
  contrastRatio,
  DARK_QUERY,
  defaultAppearancePreferences,
  deriveAccentRoles,
  flatVariantTokens,
  LEGACY_THEME_STORAGE_KEY,
  migrateLegacyThemeValue,
  normalizeAccentValue,
  normalizeAppearancePreferences,
  parseColor,
  readAppearancePreferences,
  REDUCED_TRANSPARENCY_QUERY,
  resolveAppearanceMode,
  resolveAppearanceState,
  resolveSurface,
  resolveThemeVariant,
  validateThemeRegistry,
  writeAppearancePreferences,
  type AppearancePreferencesV2,
} from '../src/components/appearance'

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

type StyleRecord = Record<string, string>

function fakeDocument() {
  const style: StyleRecord = {}
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
      classList: {
        toggle: (name: string, force: boolean) => {
          if (force) classes.add(name)
          else classes.delete(name)
        },
      },
    },
  }
  return { document, style, dataset, classes }
}

describe('color math (Zeron Color translation)', () => {
  test('colors round-trip through every supported CSS hex length', () => {
    for (const source of ['#abc', '#abcd', '#102030', '#10203040']) {
      const color = parseColor(source)
      expect(color).toBeDefined()
      expect(parseColor(colorToHex(color!))).toEqual(color)
    }
  })

  test('unsupported colors are rejected', () => {
    expect(parseColor('')).toBeUndefined()
    expect(parseColor('2563eb')).toBeUndefined()
    expect(parseColor('#12345')).toBeUndefined()
    expect(parseColor('#zzzzzz')).toBeUndefined()
  })

  test('identical colors have a contrast ratio of 1 and opposites are far apart', () => {
    expect(contrastRatio('#000000', '#000000')).toBeCloseTo(1, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0)
  })
})

describe('mode resolution (Zeron appearance semantics)', () => {
  test('system mode follows the OS', () => {
    expect(resolveAppearanceMode('system', 'light')).toBe('light')
    expect(resolveAppearanceMode('system', 'dark')).toBe('dark')
  })

  test('pinned modes ignore the OS', () => {
    for (const system of ['light', 'dark'] as const) {
      expect(resolveAppearanceMode('light', system)).toBe('light')
      expect(resolveAppearanceMode('dark', system)).toBe('dark')
    }
  })
})

describe('accent roles (Zeron AccentRoles derivation with Adea presets)', () => {
  test('every preset meets interaction contrast on both appearances', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const variant = builtinThemeRegistry.find((candidate) => candidate.appearance === appearance)!
      for (const preset of accentPresets) {
        const roles = deriveAccentRoles(preset.id, variant)
        expect(contrastRatio(roles.primary, variant.colors.background)).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(roles.onPrimary, roles.strong)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('theme selection does not override accent roles', () => {
    const variant = builtinThemeRegistry[0]!
    expect(deriveAccentRoles('theme', variant).overrides).toBe(false)
    expect(deriveAccentRoles('theme', variant).primary).toBe(variant.colors.primary)
  })

  test('a custom accent that already passes contrast is kept verbatim', () => {
    const variant = builtinThemeRegistry.find((candidate) => candidate.id === 'slate-light')!
    const roles = deriveAccentRoles('#0b57d0', variant)
    expect(roles.primary).toBe('#0b57d0')
    expect(roles.overrides).toBe(true)
  })

  test('an unknown accent value falls back to the theme accent', () => {
    const variant = builtinThemeRegistry[0]!
    const roles = deriveAccentRoles('not-a-color', variant)
    expect(roles.overrides).toBe(false)
    expect(roles.primary).toBe(variant.colors.primary)
  })

  test('normalizeAccentValue rejects unparseable input and lifts weak colors', () => {
    expect(normalizeAccentValue('blue', '#ffffff')).toBeUndefined()
    expect(normalizeAccentValue('#dddddd', '#ffffff')).not.toBe('#dddddd')
    expect(
      contrastRatio(normalizeAccentValue('#dddddd', '#ffffff')!, '#ffffff')
    ).toBeGreaterThanOrEqual(3)
  })
})

describe('surface resolution', () => {
  const environment = {
    osReducedTransparency: false,
    userReducedTransparency: false,
    nativeTranslucency: true,
  }

  test('surface preference resolves independently from the capability', () => {
    expect(resolveSurface('frosted', environment)).toBe('frosted')
    expect(resolveSurface('translucent', environment)).toBe('translucent')
    expect(resolveSurface('opaque', environment)).toBe('opaque')
  })

  test('translucent degrades to the tokenized frost without native translucency', () => {
    expect(resolveSurface('translucent', { ...environment, nativeTranslucency: false })).toBe(
      'frosted'
    )
    expect(resolveSurface('frosted', { ...environment, nativeTranslucency: false })).toBe('frosted')
  })

  test('OS and user reduced transparency force opaque', () => {
    expect(resolveSurface('translucent', { ...environment, osReducedTransparency: true })).toBe(
      'opaque'
    )
    expect(resolveSurface('frosted', { ...environment, userReducedTransparency: true })).toBe(
      'opaque'
    )
  })
})

describe('built-in theme registry', () => {
  test('every built-in passes validation with no errors', () => {
    const errors = validateThemeRegistry(builtinThemeRegistry).filter(
      (issue) => issue.severity === 'error'
    )
    expect(errors).toEqual([])
  })

  test('every variant ships complete terminal, editor, and chart roles', () => {
    for (const variant of builtinThemeRegistry) {
      expect(variant.terminal.ansi).toHaveLength(16)
      for (const value of Object.values(variant.editor)) expect(value).toMatch(/^#/)
      for (const value of Object.values(variant.charts)) expect(value).toMatch(/^#/)
    }
  })

  test('a missing variant id falls back deterministically within the same appearance', () => {
    const resolved = resolveThemeVariant(
      builtinThemeRegistry,
      { lightThemeId: 'missing-theme', darkThemeId: 'also-missing' },
      'dark'
    )
    expect(resolved.id).toBe(defaultAppearancePreferences.darkThemeId)
  })
})

describe('preference normalization and migration', () => {
  test('a v2 record round-trips', () => {
    const preferences: AppearancePreferencesV2 = {
      version: 2,
      mode: 'dark',
      lightThemeId: 'slate-light',
      darkThemeId: 'slate-dark',
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
  })

  test('corrupt records retain the raw value and fall back to defaults', () => {
    const normalized = normalizeAppearancePreferences('nonsense')
    expect(normalized.value).toEqual(defaultAppearancePreferences)
    expect(normalized.retainedRaw).toBe('nonsense')
  })

  test('individual unknown fields inside a v2 record are corrected', () => {
    const normalized = normalizeAppearancePreferences({
      version: 2,
      mode: 'sepia',
      lightThemeId: '',
      darkThemeId: 42,
      accent: '#zzzzzz',
      surface: 'glass',
      reduceTransparency: 'yes',
    })
    expect(normalized.value).toEqual(defaultAppearancePreferences)
  })

  test('the legacy theme key maps into v2 without deletion', () => {
    expect(migrateLegacyThemeValue('dark')).toEqual({
      ...defaultAppearancePreferences,
      mode: 'dark',
    })
    expect(migrateLegacyThemeValue('nonsense')).toBeUndefined()
  })

  test('storage reads the v2 key, then the legacy key, then defaults', () => {
    expect(
      readAppearancePreferences(
        memoryStorage({ [APPEARANCE_STORAGE_KEY]: JSON.stringify({ version: 2, mode: 'dark' }) })
      ).mode
    ).toBe('dark')
    expect(
      readAppearancePreferences(memoryStorage({ [LEGACY_THEME_STORAGE_KEY]: 'light' })).mode
    ).toBe('light')
    expect(
      readAppearancePreferences(memoryStorage({ [LEGACY_THEME_STORAGE_KEY]: 'bogus' })).mode
    ).toBe('system')
    expect(readAppearancePreferences(memoryStorage()).mode).toBe('system')
  })

  test('a blocked storage API degrades to defaults and never throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readAppearancePreferences(blocked)).toEqual(defaultAppearancePreferences)
    expect(() => writeAppearancePreferences(blocked, defaultAppearancePreferences)).not.toThrow()
  })
})

function envelopeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }
}

describe('storage-level read-modify-write with a recovery envelope', () => {
  test('a corrupt JSON value is quarantined and survives a later valid write byte-for-byte', () => {
    const corrupt = '{"version":2,"mode":"da'
    const storage = envelopeStorage({ [APPEARANCE_STORAGE_KEY]: corrupt })
    expect(readAppearancePreferences(storage)).toEqual(defaultAppearancePreferences)
    const envelope = JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!) as {
      schemaVersion: number
      reason: string
      raw: string
    }
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.reason).toBe('corrupt_json')
    expect(envelope.raw).toBe(corrupt)
    // Saving valid preferences must not destroy the unread original.
    writeAppearancePreferences(storage, { ...defaultAppearancePreferences, mode: 'dark' })
    expect(JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!).raw).toBe(corrupt)
    expect(readAppearancePreferences(storage).mode).toBe('dark')
  })

  test('a future-version record is quarantined and survives a later valid write', () => {
    const future = JSON.stringify({ version: 3, mode: 'sepia', nextThing: true })
    const storage = envelopeStorage({ [APPEARANCE_STORAGE_KEY]: future })
    expect(readAppearancePreferences(storage)).toEqual(defaultAppearancePreferences)
    const envelope = JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!) as {
      reason: string
      raw: string
    }
    expect(envelope.reason).toBe('unsupported_record')
    expect(envelope.raw).toBe(future)
    writeAppearancePreferences(storage, defaultAppearancePreferences)
    expect(JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!).raw).toBe(future)
  })

  test('a quarantine is idempotent across repeated reads', () => {
    const corrupt = 'not-json-at-all'
    const storage = envelopeStorage({ [APPEARANCE_STORAGE_KEY]: corrupt })
    readAppearancePreferences(storage)
    readAppearancePreferences(storage)
    expect(JSON.parse(storage.store.get(APPEARANCE_RECOVERY_STORAGE_KEY)!).raw).toBe(corrupt)
  })

  test('a valid v2 write/read round-trips and never creates a recovery envelope', () => {
    const storage = envelopeStorage()
    const preferences: AppearancePreferencesV2 = {
      version: 2,
      mode: 'light',
      lightThemeId: 'contrast-light',
      darkThemeId: 'contrast-dark',
      accent: '#112233',
      surface: 'translucent',
      reduceTransparency: true,
    }
    writeAppearancePreferences(storage, preferences)
    expect(readAppearancePreferences(storage)).toEqual(preferences)
    expect(storage.store.has(APPEARANCE_RECOVERY_STORAGE_KEY)).toBeFalse()
  })

  test('the legacy theme key still migrates without deletion and writes no envelope', () => {
    const storage = envelopeStorage({ [LEGACY_THEME_STORAGE_KEY]: 'dark' })
    expect(readAppearancePreferences(storage).mode).toBe('dark')
    expect(storage.store.get(LEGACY_THEME_STORAGE_KEY)).toBe('dark')
    expect(storage.store.has(APPEARANCE_RECOVERY_STORAGE_KEY)).toBeFalse()
    // A later write lands in the v2 key; the legacy key stays untouched.
    writeAppearancePreferences(storage, { ...defaultAppearancePreferences, surface: 'frosted' })
    expect(storage.store.get(LEGACY_THEME_STORAGE_KEY)).toBe('dark')
    expect(JSON.parse(storage.store.get(APPEARANCE_STORAGE_KEY)!).surface).toBe('frosted')
  })
})

describe('document application', () => {
  test('the default variants stay CSS-owned: no palette tokens are written', () => {
    const state = resolveAppearanceState(defaultAppearancePreferences, {
      systemAppearance: 'dark',
      osReducedTransparency: false,
      nativeTranslucency: false,
    })
    const { document, style, dataset, classes } = fakeDocument()
    applyAppearanceToDocument(document as unknown as Document, state)
    expect(classes.has('dark')).toBe(true)
    expect(dataset.theme).toBe('adea-dark')
    expect(style['--background']).toBeUndefined()
    expect(style['--surface-alpha']).toBe('1')
  })

  test('a non-default variant applies its palette and role tokens', () => {
    const preferences = { ...defaultAppearancePreferences, darkThemeId: 'slate-dark' }
    const state = resolveAppearanceState(preferences, {
      systemAppearance: 'dark',
      osReducedTransparency: false,
      nativeTranslucency: false,
    })
    const { document, style, dataset } = fakeDocument()
    applyAppearanceToDocument(document as unknown as Document, state)
    expect(dataset.theme).toBe('slate-dark')
    expect(style['--background']).toBe('#0f172a')
    // Terminal ANSI and editor roles come from the same manifest.
    expect(style['--terminal-background']).toBe(state.variant.terminal.background)
    expect(style['--terminal-ansi-red']).toBe(state.variant.terminal.ansi[1])
    expect(style['--terminal-ansi-bright-red']).toBe(state.variant.terminal.ansi[9])
    expect(style['--editor-keyword']).toBe(state.variant.editor.keyword)
    expect(style['--chart-1']).toBe(state.variant.charts.chart1)
  })

  test('an accent override touches only the accent roles', () => {
    const state = resolveAppearanceState(
      { ...defaultAppearancePreferences, accent: 'blue' },
      {
        systemAppearance: 'light',
        osReducedTransparency: false,
        nativeTranslucency: false,
      }
    )
    const { document, style } = fakeDocument()
    applyAppearanceToDocument(document as unknown as Document, state)
    expect(style['--primary']).toBe(state.accent.primary)
    expect(style['--ring']).toBe(state.accent.ring)
    expect(style['--background']).toBeUndefined()
  })

  test('returning to the theme accent removes the override it replaced', () => {
    // Inline properties beat the stylesheet, so an override that is merely
    // skipped (rather than removed) keeps painting after the user picks
    // "Theme default" — the button looked dead after any preset was tried.
    const environment = {
      systemAppearance: 'light' as const,
      osReducedTransparency: false,
      nativeTranslucency: false,
    }
    const { document, style } = fakeDocument()
    applyAppearanceToDocument(
      document as unknown as Document,
      resolveAppearanceState({ ...defaultAppearancePreferences, accent: 'blue' }, environment)
    )
    expect(style['--primary']).toBeDefined()

    applyAppearanceToDocument(
      document as unknown as Document,
      resolveAppearanceState({ ...defaultAppearancePreferences, accent: 'theme' }, environment)
    )
    expect(style['--primary']).toBeUndefined()
    expect(style['--primary-foreground']).toBeUndefined()
    expect(style['--ring']).toBeUndefined()
  })

  test('reduced transparency forces the opaque surface and is diagnosable', () => {
    const state = resolveAppearanceState(
      { ...defaultAppearancePreferences, surface: 'translucent' },
      {
        systemAppearance: 'light',
        osReducedTransparency: false,
        nativeTranslucency: true,
      }
    )
    const forced = resolveAppearanceState(
      { ...defaultAppearancePreferences, surface: 'translucent', reduceTransparency: true },
      { systemAppearance: 'light', osReducedTransparency: false, nativeTranslucency: true }
    )
    expect(state.effectiveSurface).toBe('translucent')
    const { document, dataset, style } = fakeDocument()
    applyAppearanceToDocument(document as unknown as Document, forced)
    expect(dataset.reduceTransparency).toBe('true')
    expect(dataset.surface).toBe('opaque')
    expect(style['--surface-alpha']).toBe('1')
  })
})

describe('the no-flash preload script', () => {
  function runScript(storage: Record<string, string>, systemDark = false, osReduce = false) {
    const { document, style, dataset, classes } = fakeDocument()
    const window = {
      matchMedia: (query: string) => ({
        matches:
          query === DARK_QUERY
            ? systemDark
            : query === REDUCED_TRANSPARENCY_QUERY
              ? osReduce
              : false,
      }),
    }
    new Function('window', 'document', 'localStorage', appearanceThemeScript())(
      window,
      document,
      memoryStorage(storage)
    )
    return { style, dataset, classes }
  }

  test('a stored v2 preference restores the palette before first paint', () => {
    const { dataset, classes, style } = runScript({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({
        version: 2,
        mode: 'dark',
        lightThemeId: 'adea-light',
        darkThemeId: 'slate-dark',
        surface: 'frosted',
      }),
    })
    expect(classes.has('dark')).toBe(true)
    expect(dataset.theme).toBe('slate-dark')
    expect(dataset.surface).toBe('frosted')
    expect(style['--background']).toBe('#0f172a')
  })

  test('the legacy theme key migrates with no flash and is never deleted', () => {
    const { dataset, classes } = runScript({ [LEGACY_THEME_STORAGE_KEY]: 'dark' })
    expect(classes.has('dark')).toBe(true)
    expect(dataset.theme).toBe('adea-dark')
  })

  test('no stored preference resolves the system palette', () => {
    const light = runScript({}, false)
    expect(light.classes.has('dark')).toBe(false)
    const dark = runScript({}, true)
    expect(dark.classes.has('dark')).toBe(true)
  })

  test('reduced transparency pre-paints the opaque surface', () => {
    const { dataset } = runScript(
      {
        [APPEARANCE_STORAGE_KEY]: JSON.stringify({ version: 2, surface: 'translucent' }),
      },
      false,
      true
    )
    expect(dataset.surface).toBe('opaque')
  })

  test('corrupt stored data degrades to defaults instead of throwing', () => {
    const { dataset } = runScript({ [APPEARANCE_STORAGE_KEY]: '{not json' })
    expect(dataset.theme).toBe('adea-light')
  })
})

describe('flat token map', () => {
  test('default variants own no tokens and non-default variants own the full set', () => {
    expect(flatVariantTokens(builtinThemeRegistry[0]!)).toEqual({})
    const slate = flatVariantTokens(
      builtinThemeRegistry.find((variant) => variant.id === 'slate-light')!
    )
    expect(slate['--background']).toBe('#f8fafc')
    expect(slate['--terminal-foreground']).toBeDefined()
    expect(slate['--editor-comment']).toBeDefined()
    expect(slate['--chart-6']).toBeDefined()
  })
})
