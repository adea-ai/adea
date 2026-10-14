import { describe, expect, test } from 'bun:test'

import { accentOverrideVariables, contrastRatio } from '@adea-ai/ui/lib/accent-roles'
import {
  accentRolesForSelection,
  accents,
  builtinThemes,
  themeCssVariables,
  tokensAsHex,
} from '@adea-ai/ui/lib/themes'

import { APPEARANCE_ACCENT_CONTRAST_FLOOR } from '../src/components/appearance-codec'

/** The hex the document is written with, which is what a contrast gate measures. */
function hex(value: string): string {
  return tokensAsHex({ value }).value!
}

function paintedAccent(accent: string, variantId: string) {
  const variant = builtinThemes.find((theme) => theme.id === variantId)!
  const roles = accentRolesForSelection(accent, variant.appearance, undefined, {
    background: variant.colors.background,
    floor: APPEARANCE_ACCENT_CONTRAST_FLOOR,
    variantId,
  })!
  return {
    background: hex(variant.colors.background),
    painted: tokensAsHex(accentOverrideVariables(roles)),
  }
}

describe('appearance contrast gates (ACC-05)', () => {
  test('every preset meets interaction contrast on both default themes', () => {
    for (const variantId of ['adea-light', 'adea-dark']) {
      for (const preset of accents) {
        const { background, painted } = paintedAccent(preset.id, variantId)
        expect(contrastRatio(painted['--primary']!, background)).toBeGreaterThanOrEqual(3)
        expect(
          contrastRatio(painted['--primary-foreground']!, painted['--primary']!)
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('a custom accent below the floor is lifted to it, on every appearance', () => {
    for (const variantId of ['adea-light', 'adea-dark']) {
      const { background, painted } = paintedAccent('#808080', variantId)
      expect(contrastRatio(painted['--primary']!, background)).toBeGreaterThanOrEqual(3)
    }
  })

  test('every catalogue editor role clears the host floor', () => {
    for (const theme of builtinThemes) {
      const tokens = tokensAsHex(themeCssVariables(theme, { editor: 'floor' }))
      const background = tokens['--background']!
      const roles = Object.entries(tokens).filter(([name]) => name.startsWith('--editor-'))
      expect(roles).toHaveLength(16)
      for (const [name, value] of roles) {
        expect(
          contrastRatio(value, background),
          `${theme.id} ${name} contrast`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
