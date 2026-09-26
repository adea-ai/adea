import adeaDarkTheme from '@adea-ai/themes/themes/adea-dark'
import adeaLightTheme from '@adea-ai/themes/themes/adea-light'
import { shadcnVariables } from '@adea-ai/themes/adapters/shadcn'
import { toShikiTheme } from '@adea-ai/themes/adapters/shiki'
import { themeCssVariables } from '@adea-ai/themes/adapters/css'
import { toXtermTheme } from '@adea-ai/themes/adapters/xterm'
import { oklchToHex, parseColor, repairContrast } from '@adea-ai/themes/oklch'
import type { AdeaTheme, AdeaThemeRecord } from '@adea-ai/themes/schema'

import type {
  ThemeChartRoles,
  ThemeColors,
  ThemeEditorRoles,
  ThemeTerminalPalette,
  ThemeVariant,
} from './appearance'

/** The published IDs that are also accepted by Adea's v2 preference schema. */
export const CANONICAL_ADEA_THEME_IDS = ['adea-light', 'adea-dark'] as const

type CanonicalAdeaThemeId = (typeof CANONICAL_ADEA_THEME_IDS)[number]

const SHADCN_COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'success',
  'border',
  'input',
  'ring',
] as const

const CANONICAL_ADEA_THEMES: Readonly<Record<CanonicalAdeaThemeId, AdeaThemeRecord>> = {
  'adea-light': adeaLightTheme,
  'adea-dark': adeaDarkTheme,
}

const EDITOR_ROLES = [
  'keyword',
  'string',
  'number',
  'comment',
  'function',
  'variable',
  'type',
  'tag',
  'attribute',
  'operator',
  'heading',
  'link',
  'diffAdd',
  'diffDelete',
  'diffHunk',
  'searchMatch',
] as const

type EditorRole = (typeof EDITOR_ROLES)[number]

const SHIKI_SCOPE_BY_ROLE: Readonly<Record<EditorRole, string>> = {
  keyword: 'keyword',
  string: 'string',
  number: 'constant.numeric',
  comment: 'comment',
  function: 'entity.name.function',
  variable: 'variable',
  type: 'entity.name.type',
  tag: 'entity.name.tag',
  attribute: 'entity.other.attribute-name',
  operator: 'keyword.operator',
  heading: 'markup.heading',
  link: 'markup.underline.link',
  diffAdd: 'markup.inserted',
  diffDelete: 'markup.deleted',
  diffHunk: 'meta.diff.range',
  searchMatch: 'markup.highlight',
}

function asHex(value: string, role: string): string {
  const parsed = parseColor(value)
  if (!parsed) throw new Error(`canonical Adea theme role ${role} is not a colour: ${value}`)
  return oklchToHex(parsed)
}

function canonicalShadcnTokens(theme: AdeaTheme): Record<string, string> {
  const variables = shadcnVariables(theme)
  return Object.fromEntries(
    SHADCN_COLOR_TOKENS.map((name) => {
      const cssName = `--${name}`
      const value = variables[cssName]
      if (!value) throw new Error(`canonical Adea theme is missing ${cssName}`)
      return [cssName, asHex(value, cssName)]
    })
  )
}

function canonicalSyntaxHex(theme: AdeaTheme): Record<string, string> {
  const shiki = toShikiTheme(theme)
  const background = parseColor(shiki.colors['editor.background']!)
  if (!background) throw new Error(`canonical ${theme.id} has no editor background`)

  return Object.fromEntries(
    EDITOR_ROLES.map((role) => {
      const scope = SHIKI_SCOPE_BY_ROLE[role]
      const setting = shiki.settings.find((candidate) => {
        const scopes = typeof candidate.scope === 'string' ? [candidate.scope] : candidate.scope
        return scopes?.includes(scope)
      })
      const foreground = setting?.settings.foreground
      const parsed = foreground ? parseColor(foreground) : undefined
      if (!parsed) throw new Error(`canonical ${theme.id} is missing editor.${role}`)

      // The published Shiki adapter supplies the role mapping and hex conversion;
      // Adea's editor contract additionally requires every foreground to clear
      // the text floor. Use the package's public OKLCH repair instead of local
      // contrast math, including for the dim ANSI white used by variables/operators.
      const repaired = repairContrast(parsed, background, 4.5)
      if (!repaired.satisfied) {
        throw new Error(`canonical ${theme.id} cannot repair editor.${role} contrast`)
      }
      return [role, oklchToHex(repaired.color)]
    })
  )
}

/**
 * The CSS-owned roles for a canonical theme, converted from the package's OKLCH
 * contract to the hex strings consumed by the existing appearance boundary.
 *
 * This is deliberately an adapter: the package remains the source of the
 * palette, while Adea keeps its established CSS variable names and no-flash
 * document authority.
 */
export function canonicalThemeCssTokens(id: CanonicalAdeaThemeId): Record<string, string> {
  const theme = CANONICAL_ADEA_THEMES[id]

  const tokens = canonicalShadcnTokens(theme)
  const terminal = toXtermTheme(theme)
  const ansiNames = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'bright-black',
    'bright-red',
    'bright-green',
    'bright-yellow',
    'bright-blue',
    'bright-magenta',
    'bright-cyan',
    'bright-white',
  ] as const
  const ansiValues = [
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
  ]
  Object.assign(tokens, {
    '--terminal-background': terminal.background,
    '--terminal-foreground': terminal.foreground,
    '--terminal-cursor': terminal.cursor,
    '--terminal-selection': terminal.selectionBackground,
  })
  ansiValues.forEach((value, index) => {
    tokens[`--terminal-ansi-${ansiNames[index]}`] = value
  })

  const syntax = canonicalSyntaxHex(theme)
  for (const role of EDITOR_ROLES) {
    tokens[`--editor-${role.replaceAll(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}`] =
      syntax[role]
  }
  const cssVariables = themeCssVariables(theme)
  for (let index = 1; index <= 6; index += 1) {
    const value = cssVariables[`--adea-chart-${index}`]
    if (!value) throw new Error(`canonical ${theme.id} is missing chart${index}`)
    tokens[`--chart-${index}`] = asHex(value, `chart${index}`)
  }
  return Object.freeze(tokens)
}

function canonicalColors(theme: AdeaTheme): ThemeColors {
  const tokens = canonicalShadcnTokens(theme)
  const value = (name: (typeof SHADCN_COLOR_TOKENS)[number]) => tokens[`--${name}`]!
  return {
    background: value('background'),
    foreground: value('foreground'),
    card: value('card'),
    cardForeground: value('card-foreground'),
    popover: value('popover'),
    popoverForeground: value('popover-foreground'),
    primary: value('primary'),
    primaryForeground: value('primary-foreground'),
    secondary: value('secondary'),
    secondaryForeground: value('secondary-foreground'),
    muted: value('muted'),
    mutedForeground: value('muted-foreground'),
    accent: value('accent'),
    accentForeground: value('accent-foreground'),
    destructive: value('destructive'),
    success: value('success'),
    border: value('border'),
    input: value('input'),
    ring: value('ring'),
  }
}

function canonicalTerminal(theme: AdeaTheme): ThemeTerminalPalette {
  const terminal = toXtermTheme(theme)
  return {
    background: terminal.background,
    foreground: terminal.foreground,
    cursor: terminal.cursor,
    selection: terminal.selectionBackground,
    ansi: [
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
    ],
  }
}

function canonicalEditor(theme: AdeaTheme): ThemeEditorRoles {
  const syntax = canonicalSyntaxHex(theme)
  return {
    keyword: syntax.keyword,
    string: syntax.string,
    number: syntax.number,
    comment: syntax.comment,
    function: syntax.function,
    variable: syntax.variable,
    type: syntax.type,
    tag: syntax.tag,
    attribute: syntax.attribute,
    operator: syntax.operator,
    heading: syntax.heading,
    link: syntax.link,
    diffAdd: syntax.diffAdd,
    diffDelete: syntax.diffDelete,
    diffHunk: syntax.diffHunk,
    searchMatch: syntax.searchMatch,
  }
}

function canonicalCharts(theme: AdeaTheme): ThemeChartRoles {
  const cssVariables = themeCssVariables(theme)
  const values = Array.from({ length: 6 }, (_, index) => {
    const value = cssVariables[`--adea-chart-${index + 1}`]
    if (!value) throw new Error(`canonical ${theme.id} is missing chart${index + 1}`)
    return asHex(value, `chart${index + 1}`)
  })
  return {
    chart1: values[0]!,
    chart2: values[1]!,
    chart3: values[2]!,
    chart4: values[3]!,
    chart5: values[4]!,
    chart6: values[5]!,
  }
}

/** Convert one published record into Adea's established runtime variant shape. */
export function canonicalThemeVariant(id: CanonicalAdeaThemeId): ThemeVariant {
  const theme = CANONICAL_ADEA_THEMES[id]
  return Object.freeze({
    id: theme.id,
    familyId: theme.family,
    familyName: theme.familyLabel,
    name: theme.name,
    appearance: theme.appearance,
    colors: Object.freeze(canonicalColors(theme)),
    terminal: Object.freeze(canonicalTerminal(theme)),
    editor: Object.freeze(canonicalEditor(theme)),
    charts: Object.freeze(canonicalCharts(theme)),
  })
}

export const canonicalAdeaThemeRegistry: readonly ThemeVariant[] = Object.freeze(
  CANONICAL_ADEA_THEME_IDS.map(canonicalThemeVariant)
)
