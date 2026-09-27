import { describe, expect, test } from 'bun:test'
import { ACCENTS } from '@adea-ai/themes'
import adeaDark from '@adea-ai/themes/themes/adea-dark'
import adeaLight from '@adea-ai/themes/themes/adea-light'
import { oklchToHex, parseColor } from '@adea-ai/themes/oklch'

import {
  appearanceThemeForPreview,
  appearanceThemeRecords,
  normalizeCustomAccent,
} from '../src/appearance/theme-record-adapter'
import {
  accentPresets as localAccentPresets,
  builtinThemeRegistry,
  deriveAccentRoles,
} from '@adea-ai/app-ui/components/appearance'

function canonicalHex(value: string): string {
  const color = parseColor(value)
  if (!color) throw new Error(`expected a published color: ${value}`)
  return oklchToHex(color)
}

describe('published AppearanceEditor theme adapter', () => {
  test('passes only picker identity while keeping the canonical records authoritative', () => {
    const compatibilityOptions = builtinThemeRegistry
      .filter((theme) => theme.id.startsWith('slate-') || theme.id.startsWith('contrast-'))
      .map(({ id, name, appearance }) => ({ id, name, appearance }))

    expect(appearanceThemeRecords).toEqual([
      { id: adeaLight.id, name: adeaLight.name, appearance: adeaLight.appearance },
      { id: adeaDark.id, name: adeaDark.name, appearance: adeaDark.appearance },
      ...compatibilityOptions,
    ])
    expect(Object.keys(appearanceThemeRecords[0]!).toSorted()).toEqual(['appearance', 'id', 'name'])
    expect(adeaLight.provenance).toMatchObject({
      project: 'Adea',
      url: 'https://github.com/adea-ai/themes',
      license: 'Apache-2.0',
    })
  })

  test('projects the exact published palette fields needed by the previews', () => {
    const light = builtinThemeRegistry.find((theme) => theme.id === adeaLight.id)!
    const dark = builtinThemeRegistry.find((theme) => theme.id === adeaDark.id)!
    expect(appearanceThemeForPreview(light, 'theme')).toEqual({
      id: adeaLight.id,
      name: adeaLight.name,
      appearance: adeaLight.appearance,
      colors: {
        background: canonicalHex(adeaLight.colors.background),
        foreground: canonicalHex(adeaLight.colors.foreground),
        surface: canonicalHex(adeaLight.colors.surface),
        border: canonicalHex(adeaLight.colors.border),
        accent: canonicalHex(adeaLight.colors.accent),
      },
    })
    expect(appearanceThemeForPreview(dark, 'theme').colors).toEqual({
      background: canonicalHex(adeaDark.colors.background),
      foreground: canonicalHex(adeaDark.colors.foreground),
      surface: canonicalHex(adeaDark.colors.surface),
      border: canonicalHex(adeaDark.colors.border),
      accent: canonicalHex(adeaDark.colors.accent),
    })
  })

  test('maps compatibility previews without changing their accepted IDs or colors', () => {
    const slate = builtinThemeRegistry.find((theme) => theme.id === 'slate-dark')!
    const adapted = appearanceThemeForPreview(slate, 'theme')
    expect(adapted.id).toBe('slate-dark')
    expect(adapted.appearance).toBe('dark')
    expect(adapted.colors.background).toBe(slate.colors.background)
    expect(adapted.colors.surface).toBe(slate.colors.card)
    expect(adapted.colors.foreground).toBe(slate.colors.foreground)
    expect(adapted.colors.border).toBe(slate.colors.border)
    expect(adapted.colors.accent).toBe(slate.colors.primary)
    expect(Object.keys(adapted.colors).toSorted()).toEqual([
      'accent',
      'background',
      'border',
      'foreground',
      'surface',
    ])
    expect(appearanceThemeForPreview(slate, '#2563eb').colors.accent).toBe(
      deriveAccentRoles('#2563eb', slate).primary
    )
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
