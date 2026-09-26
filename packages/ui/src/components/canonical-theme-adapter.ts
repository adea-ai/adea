import {
  chartSeries,
  getTheme,
  oklchToHex,
  parseColor,
  shadcnVariables,
  syntaxRoles,
  toXtermTheme,
  type AdeaTheme,
} from '@adea-ai/themes'

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
  // Adea's existing registry validator treats comments as readable editor text
  // (4.5:1). The package's default syntax floor is intentionally softer (2:1),
  // so use its public repair option rather than reimplementing contrast math.
  return Object.fromEntries(
    Object.entries(syntaxRoles(theme, { commentFloor: 4.5 })).map(([role, value]) => [
      role,
      asHex(value, `editor.${role}`),
    ])
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
  const theme = getTheme(id)
  if (!theme) throw new Error(`canonical Adea theme ${id} is not published`)

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
  for (const role of [
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
  ] as const) {
    tokens[`--editor-${role.replaceAll(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}`] =
      syntax[role]
  }
  chartSeries(theme).forEach((value, index) => {
    tokens[`--chart-${index + 1}`] = asHex(value, `chart${index + 1}`)
  })
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
  const values = chartSeries(theme).map((value, index) => asHex(value, `chart${index + 1}`))
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
  const theme = getTheme(id)
  if (!theme) throw new Error(`canonical Adea theme ${id} is not published`)
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
