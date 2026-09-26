import { describe, expect, test } from 'bun:test'

import adeaDarkTheme from '@adea-ai/themes/themes/adea-dark'
import adeaLightTheme from '@adea-ai/themes/themes/adea-light'
import { themeCssVariables } from '@adea-ai/themes/adapters/css'
import { toShikiTheme } from '@adea-ai/themes/adapters/shiki'
import { toXtermTheme } from '@adea-ai/themes/adapters/xterm'
import {
  contrastRatio as canonicalContrastRatio,
  parseColor,
  oklchToHex,
} from '@adea-ai/themes/oklch'
import { shadcnVariables } from '@adea-ai/themes/adapters/shadcn'

import { builtinThemeRegistry, validateThemeRegistry } from '../src/components/appearance'
import {
  CANONICAL_ADEA_THEME_IDS,
  canonicalAdeaThemeRegistry,
  canonicalThemeCssTokens,
  canonicalThemeVariant,
} from '../src/components/canonical-theme-adapter'

const canonicalThemes = {
  'adea-light': adeaLightTheme,
  'adea-dark': adeaDarkTheme,
} as const

function hex(value: string): string {
  const parsed = parseColor(value)
  if (!parsed) throw new Error(`expected a published colour: ${value}`)
  return oklchToHex(parsed)
}

function cssBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector} block`)
  const end = css.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${selector} block`)
  const declarations: Record<string, string> = {}
  for (const match of css.slice(start, end).matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    declarations[match[1]!] = match[2]!.trim()
  }
  return declarations
}

describe('published Adea theme adapter', () => {
  test('keeps the published pair in the existing registry shape', () => {
    expect(canonicalAdeaThemeRegistry.map((variant) => variant.id)).toEqual(
      CANONICAL_ADEA_THEME_IDS
    )
    expect(builtinThemeRegistry.slice(0, 2)).toEqual(canonicalAdeaThemeRegistry)

    const errors = validateThemeRegistry(canonicalAdeaThemeRegistry).filter(
      (issue) => issue.severity === 'error'
    )
    expect(errors).toEqual([])
  })

  test('maps every published role through the package adapters', () => {
    for (const id of CANONICAL_ADEA_THEME_IDS) {
      const theme = canonicalThemes[id]
      const variant = canonicalThemeVariant(id)
      const shadcn = shadcnVariables(theme)
      const terminal = toXtermTheme(theme)
      const cssVariables = themeCssVariables(theme)

      expect(variant.colors.background).toBe(hex(shadcn['--background']!))
      expect(variant.colors.primary).toBe(hex(shadcn['--primary']!))
      expect(variant.colors.accent).toBe(hex(shadcn['--accent']!))
      expect(variant.colors.destructive).toBe(hex(shadcn['--destructive']!))
      expect(variant.terminal.background).toBe(terminal.background)
      expect(variant.terminal.cursor).toBe(terminal.cursor)
      expect(variant.terminal.selection).toBe(terminal.selectionBackground)
      expect(variant.terminal.ansi).toEqual([
        terminal.black,
        terminal.red,
        terminal.green,
        terminal.yellow,
        terminal.blue,
        terminal.magenta,
        terminal.cyan,
        terminal.white,
        terminal.brightBlack,
        terminal.brightRed,
        terminal.brightGreen,
        terminal.brightYellow,
        terminal.brightBlue,
        terminal.brightMagenta,
        terminal.brightCyan,
        terminal.brightWhite,
      ])
      expect(Object.values(variant.charts)).toEqual(
        Array.from({ length: 6 }, (_, index) => hex(cssVariables[`--adea-chart-${index + 1}`]!))
      )

      const editorBackground = parseColor(variant.colors.background)
      expect(editorBackground).toBeDefined()
      for (const [role, value] of Object.entries(variant.editor)) {
        const foreground = parseColor(value)
        expect(foreground, `${id} ${role} parses`).toBeDefined()
        expect(
          canonicalContrastRatio(foreground!, editorBackground!),
          `${id} editor.${role} contrast`
        ).toBeGreaterThanOrEqual(4.5)
      }

      const shiki = toShikiTheme(theme)
      expect(shiki.colors['editor.background']).toBe(variant.colors.background)
    }
  })

  test('proves the default CSS palette matches the published adapter exactly', async () => {
    const css = await Bun.file(new URL('../src/styles/theme.css', import.meta.url)).text()
    const blocks = {
      'adea-light': cssBlock(css, ':root'),
      'adea-dark': cssBlock(css, '.dark'),
    } as const

    for (const id of CANONICAL_ADEA_THEME_IDS) {
      const actual = blocks[id]
      const expected = canonicalThemeCssTokens(id)
      for (const [name, value] of Object.entries(expected)) {
        expect(actual[name], `${id} ${name}`).toBe(value)
      }
    }
  })
})
