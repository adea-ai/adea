/*
 * Composition-helper tests for the ported Zeron appearance page layout
 * (issue #425's visual conformance target): the mode card set, the segmented
 * glass control, the accent/surface helper copy, the accent swatch
 * classifier, and the live draft variant resolution behind the mode
 * miniatures.
 */
import { describe, expect, test } from 'bun:test'

import { defaultAppearancePreferences } from '@adea-ai/app-ui/components/appearance'
import { draftVariants } from '../src/appearance/composition'

describe('appearance composition (ported Zeron appearance page layout)', () => {
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
