/*
 * Composition-helper tests for the ported Zeron appearance page layout
 * (issue #425's visual conformance target): the mode card set, the segmented
 * glass control, the accent/surface helper copy, the accent swatch
 * classifier, and the live draft variant resolution behind the mode
 * miniatures.
 */
import { describe, expect, test } from 'bun:test'

import { defaultAppearancePreferences } from '@adea-ai/ui/components/appearance'
import {
  accentHelperText,
  accentSwatchSelection,
  draftVariants,
  modeCards,
  surfaceChoices,
  surfaceHelperText,
} from '../src/appearance/composition'

describe('appearance composition (ported Zeron appearance page layout)', () => {
  test('every mode gets a live-preview card, in donor order', () => {
    expect(modeCards.map((card) => card.label)).toEqual(['System', 'Light', 'Dark'])
    expect(modeCards.map((card) => card.value)).toEqual(['system', 'light', 'dark'])
  })

  test('the glass control is a three-chip segmented control, soft to hard', () => {
    expect(surfaceChoices.map((choice) => choice.value)).toEqual([
      'translucent',
      'frosted',
      'opaque',
    ])
    expect(surfaceChoices.map((choice) => choice.label)).toEqual([
      'Translucent',
      'Frosted',
      'Opaque',
    ])
  })

  test('every glass chip carries its description line', () => {
    for (const choice of surfaceChoices) {
      expect(choice.helper.length).toBeGreaterThan(0)
      expect(surfaceHelperText(choice.value)).toBe(choice.helper)
    }
  })

  test('the accent helper explains the theme default and the override scope', () => {
    // Donor copy: the default names the palette's intent; an override names
    // what it recolors.
    expect(accentHelperText('theme')).toContain('intended color')
    expect(accentHelperText('blue')).toMatch(/^Blue · /)
    expect(accentHelperText('blue')).toContain('selections')
    expect(accentHelperText('#2563eb')).toContain('Custom color')
  })

  test('the accent swatch classifier maps theme, presets, and custom hex', () => {
    expect(accentSwatchSelection('theme')).toBe('theme')
    expect(accentSwatchSelection('violet')).toBe('violet')
    expect(accentSwatchSelection('#2563eb')).toBe('custom')
    // Unknown ids cannot masquerade as a preset swatch.
    expect(accentSwatchSelection('not-a-preset')).toBe('custom')
  })

  test('mode miniatures resolve both variants from the draft', () => {
    const variants = draftVariants({
      ...defaultAppearancePreferences,
      lightThemeId: 'slate-light',
      darkThemeId: 'slate-dark',
    })
    expect(variants.light.id).toBe('slate-light')
    expect(variants.dark.id).toBe('slate-dark')
    expect(variants.light.appearance).toBe('light')
    expect(variants.dark.appearance).toBe('dark')
  })

  test('a broken draft theme id falls back deterministically, never blank', () => {
    const variants = draftVariants({
      ...defaultAppearancePreferences,
      lightThemeId: 'missing-theme',
      darkThemeId: 'also-missing',
    })
    expect(variants.light.id).toBe(defaultAppearancePreferences.lightThemeId)
    expect(variants.dark.id).toBe(defaultAppearancePreferences.darkThemeId)
  })
})
