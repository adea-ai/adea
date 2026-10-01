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
