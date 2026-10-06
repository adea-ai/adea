import { describe, expect, test } from 'bun:test'

import {
  accentPresets,
  accentPresetById,
  APPEARANCE_RECOVERY_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY,
  applyAppearanceToDocument,
  appearanceThemeScript,
  builtinThemeRegistry,
  colorToHex,
  contrastRatio,
  DARK_QUERY,
  DEFAULT_ACCENT_PRESET_ID,
  defaultAppearancePreferences,
  deriveAccentRoles,
  flatVariantTokens,
  isThemeAccentId,
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
  themeAccentValue,
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
      setAttribute: (name: string, value: string) => {
        const key = name
          .slice(5)
          .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
        dataset[key] = value
      },
      removeAttribute: (name: string) => {
        const key = name
          .slice(5)
          .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
        delete dataset[key]
      },
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
    const variant = builtinThemeRegistry.find((candidate) => candidate.id === 'nord-light')!
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

  test('a theme-carried accent id resolves from the variant own palette', () => {
    expect(isThemeAccentId('ansi-blue')).toBe(true)
    expect(isThemeAccentId('blue')).toBe(false)
    // Only the catalogue's accent ranking is a slot; pink is a brand preset.
    expect(isThemeAccentId('ansi-pink')).toBe(false)

    const variant = builtinThemeRegistry.find((candidate) => candidate.appearance === 'dark')!
    // The protocol order is black, red, green, yellow, blue, ... — slot 4.
    expect(themeAccentValue('ansi-blue', variant)).toBe(variant.terminal.ansi[4])
    expect(themeAccentValue('ansi-green', variant)).toBe(variant.terminal.ansi[2])
    expect(themeAccentValue('ansi-pink', variant)).toBeUndefined()

    const roles = deriveAccentRoles('ansi-blue', variant)
    expect(roles.overrides).toBe(true)
    expect(contrastRatio(roles.primary, variant.colors.background)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(roles.onPrimary, roles.strong)).toBeGreaterThanOrEqual(4.5)
  })

  test('a stored theme-accent id survives preference normalization', () => {
    const document = normalizeAppearancePreferences({
      version: 2,
      mode: 'system',
      lightThemeId: 'adea-light',
      darkThemeId: 'adea-dark',
      accent: 'ansi-cyan',
      surface: 'opaque',
      reduceTransparency: false,
    })
    expect(document.value.accent).toBe('ansi-cyan')
  })

  test('the default accent is one of the catalogue presets, not a separate entry', () => {
    expect(defaultAppearancePreferences.accent).toBe(DEFAULT_ACCENT_PRESET_ID)
    expect(accentPresetById(DEFAULT_ACCENT_PRESET_ID)?.label).toBe('Violet')
  })

  test('a stored legacy theme default migrates to the default accent', () => {
    // Documents saved while "the theme's own primary" was the default carry
    // `'theme'`; that state is no longer offered, so normalization migrates it
    // instead of preserving an unpickable value.
    const document = normalizeAppearancePreferences({
      version: 2,
      mode: 'system',
      lightThemeId: 'adea-light',
      darkThemeId: 'adea-dark',
      accent: 'theme',
      surface: 'opaque',
      reduceTransparency: false,
    })
    expect(document.value.accent).toBe(DEFAULT_ACCENT_PRESET_ID)
    expect(document.retainedRaw).toBeUndefined()
  })

  test('an unparseable stored accent degrades to the default accent', () => {
    const document = normalizeAppearancePreferences({
      version: 2,
      mode: 'system',
      lightThemeId: 'adea-light',
      darkThemeId: 'adea-dark',
      accent: '#zzzzzz',
      surface: 'opaque',
      reduceTransparency: false,
    })
    expect(document.value.accent).toBe(DEFAULT_ACCENT_PRESET_ID)
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
      lightThemeId: 'nord-light',
      darkThemeId: 'nord',
      // A pin (not just the `'theme'` sentinel) must survive normalization:
      // normalizeThemeId keeps any non-empty string, so a terminal palette
      // selection is never silently reset to the interface theme.
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
      terminalThemeId: 42,
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
      lightThemeId: 'adea-light-high-contrast',
      darkThemeId: 'adea-dark-high-contrast',
      terminalThemeId: 'theme',
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

  // Every other test in this file builds a FRESH `fakeDocument()`, so the
  // suite was structurally incapable of catching a stale-inline-property
  // regression: the bug only appears when the SAME document is themed twice.
  test('switching a non-default variant back to the default clears its tokens', () => {
    const custom = resolveAppearanceState(
      { ...defaultAppearancePreferences, darkThemeId: 'nord' },
      { systemAppearance: 'dark', osReducedTransparency: false, nativeTranslucency: false }
    )
    const back = resolveAppearanceState(defaultAppearancePreferences, {
      systemAppearance: 'dark',
      osReducedTransparency: false,
      nativeTranslucency: false,
    })

    const { document, style, dataset } = fakeDocument()
    applyAppearanceToDocument(document as unknown as Document, custom)
    // The custom variant really did write tokens inline.
    expect(dataset.theme).toBe('nord')
    expect(style['--background']).toBeDefined()
    expect(style['--destructive-action']).toBe(custom.variant.colors.destructiveAction)
    expect(style['--destructive-action-foreground']).toBe(
      custom.variant.colors.destructiveActionForeground
    )
    const writtenWhileCustom = Object.keys(style).length
    expect(writtenWhileCustom).toBeGreaterThan(0)

    // Same document, back to the default variant.
    applyAppearanceToDocument(document as unknown as Document, back)
    expect(dataset.theme).toBe('adea-dark')
    expect(style['--font-ui']).toBe('var(--font-family-system)')
    expect(style['--font-content']).toBe('var(--font-family-system)')
    expect(style['--font-code']).toBe('var(--font-family-system-mono)')
    expect(style['--font-ui-size']).toBe('14px')
    expect(style['--font-content-size']).toBe('14px')
    expect(style['--font-code-size']).toBe('12px')
    expect(style['--font-ui-scale']).toBe('1')
    expect(style['--font-content-scale']).toBe('1')
    expect(style['--font-code-scale']).toBe('1')
    expect(style['--ui-tracking']).toBe('normal')
    expect(style['--ui-word-spacing']).toBe('normal')
    // No token from the previous variant may survive: the stylesheet owns them
    // again, and leaving them inline silently repaints the whole app. The font
    // role projection is host-owned; assert its exact default values above.
    const fontRoleTokens = new Set([
      '--font-ui',
      '--font-content',
      '--font-code',
      '--font-ui-size',
      '--font-content-size',
      '--font-code-size',
      '--font-ui-scale',
      '--font-content-scale',
      '--font-code-scale',
      '--ui-tracking',
      '--ui-word-spacing',
    ])
    // The default accent is the Violet preset, so the accent roles stay inline
    // after the revert: they are the preset's active override (owned by the
    // accent branch), not stale variant tokens. Pin their exact values.
    const accentOverrideTokens = new Set(['--primary', '--primary-foreground', '--ring'])
    expect(style['--primary']).toBe(back.accent.primary)
    expect(style['--primary-foreground']).toBe(back.accent.onPrimary)
    expect(style['--ring']).toBe(back.accent.ring)
    for (const name of Object.keys(style)) {
      if (
        name.startsWith('--') &&
        !name.startsWith('--surface-alpha') &&
        !fontRoleTokens.has(name) &&
        !accentOverrideTokens.has(name)
      ) {
        expect(style[name], `stale inline token ${name} survived the revert`).toBeUndefined()
      }
    }
  })

  test('a non-default variant applies its palette and role tokens', () => {
    const preferences = { ...defaultAppearancePreferences, darkThemeId: 'nord' }
    const state = resolveAppearanceState(preferences, {
      systemAppearance: 'dark',
      osReducedTransparency: false,
      nativeTranslucency: false,
    })
    const { document, style, dataset } = fakeDocument()
    applyAppearanceToDocument(document as unknown as Document, state)
    expect(dataset.theme).toBe('nord')
    expect(style['--background']).toBe(state.variant.colors.background)
    const variant = state.variant
    expect(style['--destructive-action']).toBe(variant.colors.destructiveAction)
    expect(style['--destructive-action-foreground']).toBe(
      variant.colors.destructiveActionForeground
    )
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

  test('an accent override survives a catalogue variant palette', () => {
    // A non-default variant declares its own --primary/--ring, and the variant
    // loop runs AFTER the accent branch: writing them back silently clobbered
    // the preset. Only the default pair escaped, because its flat token map is
    // empty — which is why the bug read as "accents don't work on 3rd-party
    // themes". The loop must skip the accent-owned roles while a preset is on.
    const state = resolveAppearanceState(
      { ...defaultAppearancePreferences, darkThemeId: 'nord', accent: 'blue' },
      { systemAppearance: 'dark', osReducedTransparency: false, nativeTranslucency: false }
    )
    expect(state.accent.overrides).toBe(true)
    // Precondition: nord's own primary differs from the blue preset, so a
    // clobber would be visible in the assertions below.
    expect(state.variant.colors.primary).not.toBe(state.accent.primary)

    const { document, style, dataset } = fakeDocument()
    applyAppearanceToDocument(document as unknown as Document, state)
    expect(dataset.theme).toBe('nord')
    expect(style['--primary']).toBe(state.accent.primary)
    expect(style['--primary-foreground']).toBe(state.accent.onPrimary)
    expect(style['--ring']).toBe(state.accent.ring)
    // The rest of the catalogue palette still applies around the accent.
    expect(style['--background']).toBe(state.variant.colors.background)
  })

  test('a pinned terminal palette overlays the interface variant on the same document', () => {
    const environment = {
      systemAppearance: 'dark' as const,
      osReducedTransparency: false,
      nativeTranslucency: false,
    }
    const { document, style } = fakeDocument()

    const pinned = resolveAppearanceState(
      { ...defaultAppearancePreferences, darkThemeId: 'nord', terminalThemeId: 'dracula' },
      environment
    )
    expect(pinned.terminalOverride).toBeDefined()
    expect(pinned.terminalOverride!.background).not.toBe(pinned.variant.terminal.background)
    applyAppearanceToDocument(document as unknown as Document, pinned)
    // The overlay is written last, so it wins over nord's inline terminal map.
    expect(style['--terminal-background']).toBe(pinned.terminalOverride!.background)
    expect(style['--terminal-ansi-red']).toBe(pinned.terminalOverride!.ansi[1])
    expect(style['--terminal-background']).not.toBe(pinned.variant.terminal.background)

    // Dropping the pin back to `theme` must repaint the terminal with the
    // interface variant on the SAME document — a stale dracula overlay would
    // beat the stylesheet forever.
    const followTheme = resolveAppearanceState(
      { ...defaultAppearancePreferences, darkThemeId: 'nord' },
      environment
    )
    expect(followTheme.terminalOverride).toBeUndefined()
    applyAppearanceToDocument(document as unknown as Document, followTheme)
    expect(style['--terminal-background']).toBe(followTheme.variant.terminal.background)
    expect(style['--terminal-ansi-red']).toBe(followTheme.variant.terminal.ansi[1])
  })

  test('a terminal pin on the default pair drops back to the stylesheet', () => {
    const environment = {
      systemAppearance: 'dark' as const,
      osReducedTransparency: false,
      nativeTranslucency: false,
    }
    const { document, style } = fakeDocument()

    const pinned = resolveAppearanceState(
      { ...defaultAppearancePreferences, terminalThemeId: 'dracula' },
      environment
    )
    applyAppearanceToDocument(document as unknown as Document, pinned)
    expect(style['--terminal-background']).toBe(pinned.terminalOverride!.background)

    // The default variant owns no tokens inline, so dropping the pin hands
    // every --terminal-* name back to `styles/canonical-themes.css` via the
    // removal sweep; leaving the overlay inline would pin dracula's palette
    // while dataset.theme claimed adea-dark.
    applyAppearanceToDocument(
      document as unknown as Document,
      resolveAppearanceState(defaultAppearancePreferences, environment)
    )
    expect(style['--terminal-background']).toBeUndefined()
    expect(style['--terminal-ansi-red']).toBeUndefined()
  })

  test('an unresolvable terminal id degrades to the interface palette', () => {
    const environment = {
      systemAppearance: 'dark' as const,
      osReducedTransparency: false,
      nativeTranslucency: false,
    }
    // Corruption that slips past normalize, or a theme deleted after it was
    // pinned, must never resolve to a blank or half-painted terminal.
    const deleted = resolveAppearanceState(
      { ...defaultAppearancePreferences, terminalThemeId: 'deleted-theme' },
      environment
    )
    expect(deleted.terminalOverride).toBeUndefined()
  })

  test('a legacy theme-default preference resolves to the default preset override', () => {
    // The default accent is the Violet preset now, so a legacy stored
    // `'theme'` migrates to a preset selection: the accent roles are an active
    // override, not the variant's own primary. Inline properties still beat
    // the stylesheet, so the apply step must keep rewriting (not skipping) the
    // accent roles whenever an override is on — which is every selection.
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
    const blue = style['--primary']
    expect(blue).toBeDefined()

    applyAppearanceToDocument(
      document as unknown as Document,
      resolveAppearanceState({ ...defaultAppearancePreferences, accent: 'theme' }, environment)
    )
    expect(style['--primary']).toBe(
      resolveAppearanceState(defaultAppearancePreferences, environment).accent.primary
    )
    expect(style['--primary']).not.toBe(blue)
    expect(style['--primary-foreground']).toBeDefined()
    expect(style['--ring']).toBeDefined()
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
    memoryStorage(storage)
  )
  return { style, dataset, classes }
}

describe('the no-flash preload script', () => {
  test('saved text roles match the mounted provider before first paint', () => {
    const preferences = {
      ...defaultAppearancePreferences,
      fonts: {
        ui: { family: 'geist', size: 16 },
        content: { family: 'space-grotesk', size: 18 },
        code: { family: 'jetbrains-mono', size: 13 },
      },
    } as const
    const prepaint = runScript({ [APPEARANCE_STORAGE_KEY]: JSON.stringify(preferences) })
    const mounted = fakeDocument()
    applyAppearanceToDocument(
      mounted.document as unknown as Document,
      resolveAppearanceState(preferences, {
        systemAppearance: 'light',
        osReducedTransparency: false,
        nativeTranslucency: false,
      })
    )
    for (const axis of ['ui', 'content', 'code']) {
      expect(prepaint.dataset[`${axis}Font`]).toBe(mounted.dataset[`${axis}Font`])
      expect(prepaint.style[`--font-${axis}-size`]).toBe(mounted.style[`--font-${axis}-size`])
      expect(prepaint.style[`--font-${axis}-scale`]).toBe(mounted.style[`--font-${axis}-scale`])
    }
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
    expect(style['--font-ui']).toBe('var(--font-family-system)')
  })

  test('fresh installs project System font defaults before styles paint', () => {
    const prepaint = runScript({})
    const mounted = fakeDocument()
    applyAppearanceToDocument(
      mounted.document as unknown as Document,
      resolveAppearanceState(defaultAppearancePreferences, {
        systemAppearance: 'light',
        osReducedTransparency: false,
        nativeTranslucency: false,
      })
    )
    for (const axis of ['ui', 'content', 'code']) {
      expect(prepaint.style[`--font-${axis}`]).toBe(mounted.style[`--font-${axis}`])
      expect(prepaint.style[`--font-${axis}-size`]).toBe(mounted.style[`--font-${axis}-size`])
      expect(prepaint.style[`--font-${axis}-scale`]).toBe('1')
      expect(prepaint.dataset[`${axis}Font`]).toBeUndefined()
    }
  })

  test('a stored v2 preference restores the palette before first paint', () => {
    const { dataset, classes, style } = runScript({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({
        version: 2,
        mode: 'dark',
        lightThemeId: 'adea-light',
        darkThemeId: 'nord',
        surface: 'frosted',
      }),
    })
    expect(classes.has('dark')).toBe(true)
    // The palette itself is stylesheet-owned: the resolved `data-theme`
    // attribute selects the generated token block (proven in the canonical
    // adapter tests), so the script only carries the document state.
    expect(dataset.theme).toBe('nord')
    expect(dataset.surface).toBe('frosted')
    expect(style['--surface-alpha']).toBe('0.92')
    expect(Object.keys(style).filter((name) => name.startsWith('--background'))).toEqual([])
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

  test('unknown stored theme ids pre-paint the same default as the mounted provider', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const themeId = appearance === 'dark' ? 'adea-dark' : 'adea-light'
      const expected = resolveThemeVariant(
        builtinThemeRegistry,
        { lightThemeId: 'removed-light-theme', darkThemeId: 'removed-dark-theme' },
        appearance
      )
      const { dataset } = runScript({
        [APPEARANCE_STORAGE_KEY]: JSON.stringify({
          version: 2,
          mode: appearance,
          lightThemeId: 'removed-light-theme',
          darkThemeId: 'removed-dark-theme',
        }),
      })

      expect(expected.id).toBe(themeId)
      expect(dataset.theme).toBe(expected.id)
    }
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
      builtinThemeRegistry.find((variant) => variant.id === 'nord-light')!
    )
    expect(slate['--background']).toBe(
      builtinThemeRegistry.find((variant) => variant.id === 'nord-light')!.colors.background
    )
    expect(slate['--terminal-foreground']).toBeDefined()
    expect(slate['--editor-comment']).toBeDefined()
    expect(slate['--chart-6']).toBeDefined()
  })
})

test('font preferences recover through the shared contract and round-trip device storage', () => {
  const storage = memoryStorage()
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
  writeAppearancePreferences(storage, normalized)
  expect(readAppearancePreferences(storage)).toEqual(normalized)
  expect(normalizeAppearancePreferences(defaultAppearancePreferences).value).toEqual(
    defaultAppearancePreferences
  )
})
