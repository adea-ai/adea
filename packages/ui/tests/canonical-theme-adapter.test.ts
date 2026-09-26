import { describe, expect, test } from 'bun:test'

import {
  chartSeries,
  getTheme,
  oklchToHex,
  parseColor,
  shadcnVariables,
  syntaxRoles,
  toXtermTheme,
} from '@adea-ai/themes'

import { builtinThemeRegistry, validateThemeRegistry } from '../src/components/appearance'
import {
  CANONICAL_ADEA_THEME_IDS,
  canonicalAdeaThemeRegistry,
  canonicalThemeCssTokens,
  canonicalThemeVariant,
} from '../src/components/canonical-theme-adapter'

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
      const theme = getTheme(id)!
      const variant = canonicalThemeVariant(id)
      const shadcn = shadcnVariables(theme)
      const terminal = toXtermTheme(theme)
      const syntax = syntaxRoles(theme, { commentFloor: 4.5 })
      const charts = chartSeries(theme)

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
      expect(variant.editor.comment).toBe(hex(syntax.comment))
      expect(variant.editor.diffAdd).toBe(hex(syntax.diffAdd))
      expect(Object.values(variant.charts)).toEqual(charts.map(hex))
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
