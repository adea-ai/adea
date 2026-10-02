import { describe, expect, test } from 'bun:test'
import { ACCENTS } from '@adea-ai/themes'
import adeaDark from '@adea-ai/themes/themes/adea-dark'
import adeaLight from '@adea-ai/themes/themes/adea-light'

import {
  DEFAULT_CUSTOM_ACCENT,
  appearanceThemeForPreview,
  appearanceThemeRecords,
  normalizeCustomAccent,
} from '../src/appearance/theme-record-adapter'
import {
  accentPresets as localAccentPresets,
  builtinThemeRegistry,
  deriveAccentRoles,
  setCustomThemes,
  type ThemeVariant,
} from '@adea-ai/app-ui/components/appearance'

describe('published AppearanceEditor theme adapter', () => {
  test('exposes the whole built-in registry led by the published pair', () => {
    expect(appearanceThemeRecords.map((theme) => theme.id)).toEqual(
      builtinThemeRegistry.map((variant) => variant.id)
    )
    expect(appearanceThemeRecords.slice(0, 2).map((theme) => theme.id)).toEqual([
      'adea-light',
      'adea-dark',
    ])
    expect(appearanceThemeRecords.find((theme) => theme.id === adeaLight.id)).toEqual(adeaLight)
    expect(appearanceThemeRecords.find((theme) => theme.id === adeaDark.id)).toEqual(adeaDark)
  })

  test('projects catalogue records with their published family and provenance', () => {
    const mocha = appearanceThemeRecords.find((theme) => theme.id === 'catppuccin-mocha')!
    expect(mocha.family).toBe('catppuccin')
    expect(mocha.familyLabel).toBe('Catppuccin')
    expect(mocha.label).toBe('Mocha')
    expect(mocha.description.length).toBeGreaterThan(0)
    expect(mocha.provenance.project).toBe('Catppuccin')
    expect(mocha.provenance.license).toBe('MIT')
    expect(mocha.tags).toContain('dark')
  })

  test('maps catalogue records without changing their accepted IDs', () => {
    const slate = builtinThemeRegistry.find((theme) => theme.id === 'nord')!
    const adapted = appearanceThemeForPreview(slate, 'theme')
    expect(adapted.id).toBe('nord')
    expect(adapted.appearance).toBe('dark')
    expect(adapted.colors.background).toBe(slate.colors.background)
    expect(adapted.colors.surface).toBe(slate.colors.card)
    expect(adapted.tags).toContain('dark')
  })

  test('maps custom accent roles while preserving the compatibility theme baseline', () => {
    const slate = builtinThemeRegistry.find((theme) => theme.id === 'nord')!
    const baseline = appearanceThemeForPreview(slate, 'theme')
    const accent = '#2563eb'
    const expectedAccent = deriveAccentRoles(accent, slate)
    const adapted = appearanceThemeForPreview(slate, accent)

    expect(adapted.colors.accent).toBe(expectedAccent.primary)
    expect(adapted.colors.accentForeground).toBe(expectedAccent.onPrimary)
    expect(adapted.colors.background).toBe(baseline.colors.background)
    expect(adapted.colors.foreground).toBe(baseline.colors.foreground)
    expect(adapted.colors.surface).toBe(baseline.colors.surface)
    expect(adapted.colors.border).toBe(baseline.colors.border)
  })

  test('applies the accent to imported themes that have no eager record', () => {
    // Imported variants live only in the runtime library, so they miss the
    // eagerly-built recordById and are projected on the spot. The accent
    // overlay used to run only on the record path, which made presets read
    // as dead on exactly the 3rd-party themes the user just imported.
    const nord = builtinThemeRegistry.find((theme) => theme.id === 'nord')!
    const variant: ThemeVariant = { ...nord, id: 'custom-imported-preview-test' }
    setCustomThemes(
      [
        {
          id: 'custom-imported-preview-test',
          name: 'Imported preview test',
          appearance: 'dark',
          importedAt: '2026-10-02T00:00:00.000Z',
          variant,
          flatTokens: {},
          notes: [],
        },
      ],
      undefined
    )
    try {
      const accent = '#2563eb'
      const roles = deriveAccentRoles(accent, variant)
      const adapted = appearanceThemeForPreview(variant, accent)
      expect(adapted.colors.accent).toBe(roles.primary)
      expect(adapted.colors.accentForeground).toBe(roles.onPrimary)
      // The overlay decorates the theme; its own baseline stays intact.
      expect(adapted.colors.background).toBe(nord.colors.background)
      expect(adapted.colors.border).toBe(nord.colors.border)
      // The theme-default sentinel still previews the untouched record, whose
      // accent role is the variant's own primary.
      expect(appearanceThemeForPreview(variant, 'theme').colors.accent).toBe(nord.colors.primary)
    } finally {
      setCustomThemes([], undefined)
    }
  })

  test('rejects raw invalid accents and normalizes accepted values', () => {
    expect(normalizeCustomAccent('not-a-color', '#ffffff')).toEqual({
      error: `“not-a-color” is not a hex color such as ${DEFAULT_CUSTOM_ACCENT}.`,
    })
    expect(normalizeCustomAccent(DEFAULT_CUSTOM_ACCENT, '#ffffff')).toEqual({
      value: DEFAULT_CUSTOM_ACCENT,
    })
  })

  test('derives the default custom accent from the published blue preset', () => {
    const publishedBlue = localAccentPresets.find((preset) => preset.id === 'blue')
    expect(DEFAULT_CUSTOM_ACCENT).toBe(publishedBlue?.light ?? adeaLight.colors.accent)
  })

  test('keeps the app accent projection byte-for-byte aligned with the published catalogue', () => {
    expect(localAccentPresets).toHaveLength(ACCENTS.length)
    expect(localAccentPresets).toEqual(ACCENTS)
  })
})
