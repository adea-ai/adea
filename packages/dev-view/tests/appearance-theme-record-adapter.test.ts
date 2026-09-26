import { describe, expect, test } from 'bun:test'
import { ACCENTS } from '@adea-ai/themes'
import adeaDark from '@adea-ai/themes/themes/adea-dark'
import adeaLight from '@adea-ai/themes/themes/adea-light'

import {
  appearanceThemeForPreview,
  appearanceThemeRecords,
  normalizeCustomAccent,
} from '../src/appearance/theme-record-adapter'
import {
  accentPresets as localAccentPresets,
  builtinThemeRegistry,
} from '@adea-ai/app-ui/components/appearance'

describe('published AppearanceEditor theme adapter', () => {
  test('exposes only Adea accepted IDs and preserves published canonical records', () => {
    expect(appearanceThemeRecords.map((theme) => theme.id)).toEqual([
      'adea-light',
      'adea-dark',
      'slate-light',
      'slate-dark',
      'contrast-light',
      'contrast-dark',
    ])
    expect(appearanceThemeRecords.find((theme) => theme.id === adeaLight.id)).toEqual(adeaLight)
    expect(appearanceThemeRecords.find((theme) => theme.id === adeaDark.id)).toEqual(adeaDark)
  })

  test('maps compatibility records without changing their accepted IDs', () => {
    const slate = builtinThemeRegistry.find((theme) => theme.id === 'slate-dark')!
    const adapted = appearanceThemeForPreview(slate, 'theme')
    expect(adapted.id).toBe('slate-dark')
    expect(adapted.appearance).toBe('dark')
    expect(adapted.colors.background).toBe(slate.colors.background)
    expect(adapted.colors.surface).toBe(slate.colors.card)
    expect(adapted.tags).toContain('compatibility')
  })

  test('rejects raw invalid accents and normalizes accepted values', () => {
    expect(normalizeCustomAccent('not-a-color', '#ffffff')).toEqual({
      error: '“not-a-color” is not a hex color such as #2563eb.',
    })
    expect(normalizeCustomAccent('#2563eb', '#ffffff')).toEqual({ value: '#2563eb' })
  })

  test('keeps the app accent projection byte-for-byte aligned with the published catalogue', () => {
    expect(localAccentPresets).toHaveLength(ACCENTS.length)
    expect(localAccentPresets).toEqual(
      ACCENTS.map(({ id, label, light, dark }) => ({ id, label, light, dark }))
    )
  })
})
