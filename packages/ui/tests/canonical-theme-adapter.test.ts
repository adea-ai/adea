import { describe, expect, test } from 'bun:test'

import adeaDarkTheme from '@adea-ai/themes/themes/adea-dark'
import adeaLightTheme from '@adea-ai/themes/themes/adea-light'
import { chartSeries, editorRolesHex, getTheme, syntaxRolesHex } from '@adea-ai/themes'
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
  CANONICAL_THEME_IDS,
  canonicalAdeaThemeRegistry,
  canonicalThemeRegistry,
  canonicalThemeVariant,
} from '../src/components/canonical-theme-adapter'
import { canonicalThemeCssTokens } from '../src/components/canonical-theme-css-data'
import {
  CANONICAL_THEME_COLOR_VALUES,
  CANONICAL_THEME_DATA,
  CANONICAL_THEME_PACKAGE,
  CANONICAL_THEME_VERSION,
} from '../src/components/canonical-theme-data'

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
  test('records the generated package provenance', () => {
    expect(CANONICAL_THEME_PACKAGE).toBe('@adea-ai/themes')
    expect(CANONICAL_THEME_VERSION).toBe('0.6.1')
  })

  test('generates every saved theme ID from the published catalogue', () => {
    expect(CANONICAL_THEME_IDS.map((id) => getTheme(id)?.id)).toEqual(CANONICAL_THEME_IDS)
    expect(Object.keys(CANONICAL_THEME_DATA)).toEqual(CANONICAL_THEME_IDS)
    expect(CANONICAL_THEME_COLOR_VALUES.length).toBeGreaterThan(0)
    for (const record of Object.values(CANONICAL_THEME_DATA)) {
      expect(record[0]).toHaveLength(4)
      expect(record[1]).toHaveLength(19)
      expect(record[2]).toHaveLength(18)
      expect(record[3]).toHaveLength(16)
      for (const encoded of record.slice(1)) {
        for (const value of encoded) {
          const index = value.charCodeAt(0) - 48
          expect(index).toBeGreaterThanOrEqual(0)
          expect(index).toBeLessThan(CANONICAL_THEME_COLOR_VALUES.length)
        }
      }
    }
  })

  test('projects every published saved palette with its exact CSS alpha and derived roles', () => {
    expect(canonicalThemeRegistry.map((variant) => variant.id)).toEqual(CANONICAL_THEME_IDS)

    const shadcnNames = {
      background: '--background',
      foreground: '--foreground',
      card: '--card',
      cardForeground: '--card-foreground',
      popover: '--popover',
      popoverForeground: '--popover-foreground',
      primary: '--primary',
      primaryForeground: '--primary-foreground',
      secondary: '--secondary',
      secondaryForeground: '--secondary-foreground',
      muted: '--muted',
      mutedForeground: '--muted-foreground',
      accent: '--accent',
      accentForeground: '--accent-foreground',
      destructive: '--destructive',
      success: '--success',
      border: '--border',
      input: '--input',
      ring: '--ring',
    } as const

    for (const id of CANONICAL_THEME_IDS) {
      const theme = getTheme(id)!
      const variant = canonicalThemeVariant(id)
      const shadcn = shadcnVariables(theme)
      const terminal = toXtermTheme(theme)

      expect(variant.familyId).toBe(theme.family)
      expect(variant.familyName).toBe(theme.familyLabel)
      expect(variant.name).toBe(theme.name)
      expect(variant.appearance).toBe(theme.appearance)
      for (const [role, cssName] of Object.entries(shadcnNames)) {
        const value = shadcn[cssName]!
        expect(variant.colors[role as keyof typeof variant.colors], `${id} ${role}`).toBe(
          value.startsWith('rgba(') ? value : hex(value)
        )
        expect(canonicalThemeCssTokens(id)[cssName], `${id} ${cssName}`).toBe(
          value.startsWith('rgba(') ? value : hex(value)
        )
      }

      expect(variant.terminal.background).toBe(terminal.background)
      expect(variant.terminal.foreground).toBe(terminal.foreground)
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

      const publishedEditor = editorRolesHex(theme)
      for (const [role, value] of Object.entries(variant.editor)) {
        expect(value, `${id} editor.${role} published projection`).toBe(
          publishedEditor[role as keyof typeof publishedEditor]
        )
      }

      expect(Object.values(variant.charts)).toEqual(chartSeries(theme).map((value) => hex(value)))
    }
  })

  test('uses the published records as the complete built-in registry', () => {
    expect(builtinThemeRegistry.map((variant) => variant.id)).toEqual(CANONICAL_THEME_IDS)
    expect(builtinThemeRegistry).toEqual(canonicalThemeRegistry)
    expect(
      validateThemeRegistry(builtinThemeRegistry).filter(({ severity }) => severity === 'error')
    ).toEqual([])
  })

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

  test('freezes the canonical registry and every nested role map', () => {
    expect(Object.isFrozen(canonicalAdeaThemeRegistry)).toBe(true)
    for (const variant of canonicalAdeaThemeRegistry) {
      expect(Object.isFrozen(variant)).toBe(true)
      expect(Object.isFrozen(variant.colors)).toBe(true)
      expect(Object.isFrozen(variant.terminal)).toBe(true)
      expect(Object.isFrozen(variant.terminal.ansi)).toBe(true)
      expect(Object.isFrozen(variant.editor)).toBe(true)
      expect(Object.isFrozen(variant.charts)).toBe(true)

      const colors = variant.colors as Record<string, string>
      expect(() => {
        colors.background = '#000000'
      }).toThrow()
    }

    const registry = canonicalAdeaThemeRegistry as unknown as ThemeVariant[]
    expect(() => registry.push(canonicalThemeVariant('adea-light'))).toThrow()
  })

  test('maps every published role through the package adapters', () => {
    for (const id of CANONICAL_ADEA_THEME_IDS) {
      const theme = canonicalThemes[id]
      const variant = canonicalThemeVariant(id)
      const shadcn = shadcnVariables(theme)
      const terminal = toXtermTheme(theme)

      const shadcnNames = {
        background: '--background',
        foreground: '--foreground',
        card: '--card',
        cardForeground: '--card-foreground',
        popover: '--popover',
        popoverForeground: '--popover-foreground',
        primary: '--primary',
        primaryForeground: '--primary-foreground',
        secondary: '--secondary',
        secondaryForeground: '--secondary-foreground',
        muted: '--muted',
        mutedForeground: '--muted-foreground',
        accent: '--accent',
        accentForeground: '--accent-foreground',
        destructive: '--destructive',
        success: '--success',
        border: '--border',
        input: '--input',
        ring: '--ring',
      } as const
      for (const [role, cssName] of Object.entries(shadcnNames)) {
        expect(variant.colors[role as keyof typeof variant.colors], `${id} ${role}`).toBe(
          hex(shadcn[cssName]!)
        )
      }
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
        ['blue', 'magenta', 'cyan', 'green', 'yellow', 'red'].map((role) =>
          hex(theme.ansi[role as keyof typeof theme.ansi])
        )
      )

      const editorBackground = parseColor(variant.colors.background)
      expect(editorBackground).toBeDefined()
      const publishedEditor = editorRolesHex(theme)
      for (const [role, value] of Object.entries(variant.editor)) {
        const foreground = parseColor(value)
        expect(foreground, `${id} ${role} parses`).toBeDefined()
        expect(
          canonicalContrastRatio(foreground!, editorBackground!),
          `${id} editor.${role} contrast`
        ).toBeGreaterThanOrEqual(4.5)
        expect(value, `${id} editor.${role} published projection`).toBe(
          publishedEditor[role as keyof typeof publishedEditor]
        )
      }

      const shiki = toShikiTheme(theme)
      expect(shiki.colors['editor.background']).toBe(variant.colors.background)
    }
  })

  test('the published editor projection preserves quiet syntax but clears rounded contrast', () => {
    const theme = getTheme('contrast-dark')!
    const editor = editorRolesHex(theme)
    const variant = canonicalThemeVariant('contrast-dark')

    expect(syntaxRolesHex(theme).comment).toBe('#57606a')
    expect(editor.comment).toBe('#6c7680')
    expect(variant.editor.comment).toBe(editor.comment)
    expect(
      canonicalContrastRatio(parseColor(editor.comment)!, parseColor(theme.colors.background)!)
    ).toBeGreaterThanOrEqual(4.5)
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
