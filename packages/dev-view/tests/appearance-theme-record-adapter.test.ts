import { describe, expect, test } from 'bun:test'
import { ACCENTS } from '@adea-ai/themes'
import adeaDark from '@adea-ai/themes/themes/adea-dark'
import adeaLight from '@adea-ai/themes/themes/adea-light'

import {
  DEFAULT_CUSTOM_ACCENT,
  appearanceThemeForPreview,
  appearanceThemeRecords,
  customThemeRecords,
  normalizeCustomAccent,
} from '../src/appearance/theme-record-adapter'
import {
  setCustomThemes,
  themeRegistry,
  flatVariantTokens,
  type StoredThemeVariant,
} from '@adea-ai/app-ui/components/custom-theme-library'
import { accentRolesForSelection, builtinThemes, themeRecords } from '@adea-ai/ui/lib/themes'

const byId = (id: string) => builtinThemes.find((theme) => theme.id === id)!

describe('published AppearanceEditor theme adapter', () => {
  test('exposes the whole built-in catalogue led by the published pair', () => {
    expect(appearanceThemeRecords.map((theme) => theme.id).toSorted()).toEqual(
      builtinThemes.map((variant) => variant.id).toSorted()
    )
    expect(appearanceThemeRecords.slice(0, 2).map((theme) => theme.id)).toEqual([
      'adea-light',
      'adea-dark',
    ])
    expect(appearanceThemeRecords.find((theme) => theme.id === adeaLight.id)).toEqual(adeaLight)
    expect(appearanceThemeRecords.find((theme) => theme.id === adeaDark.id)).toEqual(adeaDark)
  })

  test('hands the editor the catalogue records themselves', () => {
    const mocha = appearanceThemeRecords.find((theme) => theme.id === 'catppuccin-mocha')!
    expect(mocha).toBe(themeRecords.find((theme) => theme.id === 'catppuccin-mocha')!)
    expect(mocha.family).toBe('catppuccin')
    expect(mocha.familyLabel).toBe('Catppuccin')
    expect(mocha.label).toBe('Mocha')
    expect(mocha.description.length).toBeGreaterThan(0)
    expect(mocha.provenance.project).toBe('Catppuccin')
    expect(mocha.provenance.license).toBe('MIT')
    expect(mocha.tags).toContain('dark')
  })

  test('maps catalogue records without changing their accepted IDs', () => {
    const nord = byId('nord')
    const adapted = appearanceThemeForPreview(nord, 'theme')
    expect(adapted.id).toBe('nord')
    expect(adapted.appearance).toBe('dark')
    expect(adapted).toBe(themeRecords.find((theme) => theme.id === 'nord')!)
  })

  test('maps custom accent roles while preserving the theme baseline', () => {
    const nord = byId('nord')
    const baseline = appearanceThemeForPreview(nord, 'theme')
    const accent = '#2563eb'
    const expectedAccent = accentRolesForSelection(accent, 'dark', undefined, {
      background: nord.colors.background,
      floor: 3,
      variantId: 'nord',
    })!
    const adapted = appearanceThemeForPreview(nord, accent)

    expect(adapted.colors.accent).toBe(expectedAccent.primary)
    expect(adapted.colors.accentForeground).toBe(expectedAccent.primaryForeground)
    expect(adapted.colors.background).toBe(baseline.colors.background)
    expect(adapted.colors.foreground).toBe(baseline.colors.foreground)
    expect(adapted.colors.surface).toBe(baseline.colors.surface)
    expect(adapted.colors.border).toBe(baseline.colors.border)
  })

  test('reads a theme-derived accent from the draft pair', () => {
    const nord = byId('nord')
    const pair = { lightThemeId: 'adea-light', darkThemeId: 'nord' }
    const adapted = appearanceThemeForPreview(nord, 'ansi-blue', pair)
    const expected = accentRolesForSelection('ansi-blue', 'dark', pair, {
      background: nord.colors.background,
      floor: 3,
      variantId: 'nord',
    })!
    expect(adapted.colors.accent).toBe(expected.primary)
  })

  test('applies the accent to imported themes that have no catalogue record', () => {
    // Imported variants live only in the runtime library; the accent overlay used
    // to run only on the record path, which made presets read as dead on exactly
    // the 3rd-party themes the user just imported.
    const nord = byId('nord')
    const stored: StoredThemeVariant = {
      id: 'custom-imported-preview-test',
      familyId: 'imported',
      familyName: 'Imported',
      name: 'Imported preview test',
      appearance: 'dark',
      colors: {
        background: '#1e2127',
        foreground: '#d7dae0',
        card: '#262a31',
        cardForeground: '#d7dae0',
        popover: '#2c313a',
        popoverForeground: '#d7dae0',
        primary: '#61afef',
        primaryForeground: '#10161d',
        secondary: '#2c313a',
        secondaryForeground: '#d7dae0',
        muted: '#2c313a',
        mutedForeground: '#9aa2b1',
        accent: '#323844',
        accentForeground: '#d7dae0',
        destructive: '#e06c75',
        destructiveAction: '#e06c75',
        destructiveActionForeground: '#10161d',
        success: '#98c379',
        border: '#3a404c',
        input: '#3a404c',
        ring: '#61afef',
      },
      terminal: {
        background: '#1e2127',
        foreground: '#d7dae0',
        cursor: '#56b6c2',
        selection: '#5c6370',
        ansi: Array.from({ length: 16 }, () => '#abb2bf'),
      },
      editor: {
        keyword: '#c678dd',
        string: '#98c379',
        number: '#e5c07b',
        comment: '#9aa2b1',
        function: '#61afef',
        variable: '#56b6c2',
        type: '#56b6c2',
        tag: '#e06c75',
        attribute: '#e5c07b',
        operator: '#d7dae0',
        heading: '#c678dd',
        link: '#61afef',
        diffAdd: '#98c379',
        diffDelete: '#e06c75',
        diffHunk: '#9aa2b1',
        searchMatch: '#e5c07b',
      },
      charts: {
        chart1: '#61afef',
        chart2: '#c678dd',
        chart3: '#56b6c2',
        chart4: '#98c379',
        chart5: '#e5c07b',
        chart6: '#e06c75',
      },
    }
    setCustomThemes(
      [
        {
          id: stored.id,
          name: stored.name,
          appearance: 'dark',
          importedAt: '2026-10-02T00:00:00.000Z',
          variant: stored,
          flatTokens: flatVariantTokens(stored),
          notes: [],
        },
      ],
      undefined
    )
    try {
      const variant = themeRegistry().find((candidate) => candidate.id === stored.id)!
      expect(customThemeRecords().map((record) => record.id)).toEqual([stored.id])
      const accent = '#2563eb'
      const roles = accentRolesForSelection(accent, 'dark', undefined, {
        background: variant.colors.background,
        floor: 3,
        variantId: variant.id,
      })!
      const adapted = appearanceThemeForPreview(variant, accent)
      expect(adapted.colors.accent).toBe(roles.primary)
      expect(adapted.colors.accentForeground).toBe(roles.primaryForeground)
      // The overlay decorates the theme; its own baseline stays intact.
      expect(adapted.colors.background).toBe(stored.colors.background)
      expect(adapted.colors.border).toBe(stored.colors.border)
      // The theme-default sentinel still previews the untouched record, whose
      // accent role is the stored primary.
      expect(appearanceThemeForPreview(variant, 'theme').colors.accent).toBe(stored.colors.primary)
      expect(nord.id).toBe('nord')
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
    // A weak colour is lifted to the contrast floor, and the stored spelling is #rrggbb.
    const lifted = normalizeCustomAccent('#dddddd', '#ffffff').value!
    expect(lifted).toMatch(/^#[0-9a-f]{6}$/)
    expect(lifted).not.toBe('#dddddd')
    expect(normalizeCustomAccent('#11223380', '#ffffff').value).toMatch(/^#[0-9a-f]{6}$/)
  })

  test('derives the default custom accent from the published blue preset', () => {
    const publishedBlue = ACCENTS.find((preset) => preset.id === 'blue')
    expect(DEFAULT_CUSTOM_ACCENT).toBe(publishedBlue?.light ?? adeaLight.colors.accent)
  })
})
