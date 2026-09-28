import { chartSeries, editorRolesHex, getTheme, type AdeaThemeRecord } from '@adea-ai/themes'
import { oklchToHex, parseColor } from '@adea-ai/themes/oklch'
import { shadcnVariables, shadcnDestructiveProjection } from '@adea-ai/themes/adapters/shadcn'
import { toXtermTheme } from '@adea-ai/themes/adapters/xterm'

const OUTPUT = new URL('../src/components/canonical-theme-data.ts', import.meta.url)
const CSS_OUTPUT = new URL('../src/components/canonical-theme-css-data.ts', import.meta.url)
const CHECK_ONLY = Bun.argv.includes('--check')
const themePackage = await Bun.file(
  new URL('../package.json', import.meta.resolve('@adea-ai/themes'))
).json()
const themeVersion: string = themePackage.version
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
const SHADCN_TO_COLOR = {
  background: 'background',
  foreground: 'foreground',
  card: 'card',
  'card-foreground': 'cardForeground',
  popover: 'popover',
  'popover-foreground': 'popoverForeground',
  primary: 'primary',
  'primary-foreground': 'primaryForeground',
  secondary: 'secondary',
  'secondary-foreground': 'secondaryForeground',
  muted: 'muted',
  'muted-foreground': 'mutedForeground',
  accent: 'accent',
  'accent-foreground': 'accentForeground',
  destructive: 'destructive',
  'destructive-action': 'destructiveAction',
  'destructive-action-foreground': 'destructiveActionForeground',
  success: 'success',
  border: 'border',
  input: 'input',
  ring: 'ring',
} as const
const ANSI_NAMES = [
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
const ANSI_CHART_INDEXES = [4, 5, 6, 2, 3, 1] as const

function hex(value: string, role: string): string {
  const parsed = parseColor(value)
  if (!parsed) throw new Error(`canonical role ${role} is not a colour: ${value}`)
  return oklchToHex(parsed)
}

function colorValue(value: string, role: string): string {
  // The published shadcn projection retains source-authored alpha on borders
  // and inputs. Keep that CSS value byte-for-byte; every other palette value is
  // normalized to the existing hex runtime contract.
  if (value.startsWith('rgba(')) return value
  return hex(value, role)
}

function publishedTheme(id: string): AdeaThemeRecord {
  const theme = getTheme(id)
  if (!theme) throw new Error(`published @adea-ai/themes is missing ${id}`)
  return theme
}

function makeRecord(theme: AdeaThemeRecord) {
  const action = shadcnDestructiveProjection(theme)
  const shadcn = {
    ...shadcnVariables(theme),
    '--destructive-action': action.fill,
    '--destructive-action-foreground': action.foreground,
  }
  const colors = Object.fromEntries(
    Object.entries(SHADCN_TO_COLOR).map(([name, property]) => [
      property,
      colorValue(shadcn[`--${name}`]!, `--${name}`),
    ])
  )
  const terminal = toXtermTheme(theme)
  const terminalValues = [
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
  const editor = editorRolesHex(theme)
  const charts = Object.fromEntries(
    chartSeries(theme).map((value, index) => [`chart${index + 1}`, hex(value, `chart${index + 1}`)])
  )
  const variant = {
    id: theme.id,
    familyId: theme.family,
    familyName: theme.familyLabel,
    name: theme.name,
    appearance: theme.appearance,
    colors,
    terminal: {
      background: hex(terminal.background, 'terminal.background'),
      foreground: hex(terminal.foreground, 'terminal.foreground'),
      cursor: hex(terminal.cursor, 'terminal.cursor'),
      selection: hex(terminal.selectionBackground, 'terminal.selectionBackground'),
      ansi: terminalValues.map((value, index) => hex(value, `terminal.${ANSI_NAMES[index]}`)),
    },
    editor,
    charts,
  }
  const cssTokens: Record<string, string> = Object.fromEntries(
    Object.keys(SHADCN_TO_COLOR).map((name) => [
      `--${name}`,
      colorValue(shadcn[`--${name}`]!, `--${name}`),
    ])
  )
  Object.assign(cssTokens, {
    '--terminal-background': variant.terminal.background,
    '--terminal-foreground': variant.terminal.foreground,
    '--terminal-cursor': variant.terminal.cursor,
    '--terminal-selection': variant.terminal.selection,
  })
  variant.terminal.ansi.forEach((value, index) => {
    cssTokens[`--terminal-ansi-${ANSI_NAMES[index]}`] = value
  })
  for (const role of EDITOR_ROLES) {
    cssTokens[`--editor-${role.replaceAll(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}`] =
      variant.editor[role]
  }
  for (const [index, ansiIndex] of ANSI_CHART_INDEXES.entries()) {
    cssTokens[`--chart-${index + 1}`] = variant.terminal.ansi[ansiIndex]!
  }
  return { variant, cssTokens }
}

const records = {
  'adea-light': makeRecord(publishedTheme('adea-light')),
  'adea-dark': makeRecord(publishedTheme('adea-dark')),
  'slate-light': makeRecord(publishedTheme('slate-light')),
  'slate-dark': makeRecord(publishedTheme('slate-dark')),
  'contrast-light': makeRecord(publishedTheme('contrast-light')),
  'contrast-dark': makeRecord(publishedTheme('contrast-dark')),
}
const variants = Object.fromEntries(
  Object.entries(records).map(([id, record]) => {
    const variant = record.variant
    return [
      id,
      [
        [variant.name, variant.appearance, variant.familyId, variant.familyName],
        Object.values(variant.colors),
        [variant.terminal.cursor, variant.terminal.selection, ...variant.terminal.ansi],
        Object.values(variant.editor),
      ],
    ]
  })
)
const colors = Array.from(
  new Set(
    Object.values(variants).flatMap((record) =>
      record.slice(1).flatMap((values) => values as string[])
    )
  )
)
const colorIndex = new Map(colors.map((value, index) => [value, index]))
const compactVariants = Object.fromEntries(
  Object.entries(variants).map(([id, record]) => [
    id,
    [
      record[0],
      ...record
        .slice(1)
        .map((values) => (values as string[]).map((value) => colorIndex.get(value))),
    ],
  ])
)
const encodedVariants = Object.fromEntries(
  Object.entries(compactVariants).map(([id, record]) => [
    id,
    [
      record[0],
      ...record
        .slice(1)
        .map((values) => String.fromCharCode(...(values as number[]).map((index) => index + 48))),
    ],
  ])
)
const cssTokens = Object.fromEntries(
  Object.entries(records).map(([id, record]) => [id, record.cssTokens])
)
const source = `/** Generated from the isolated @adea-ai/themes ${themeVersion} records. */\nexport const CANONICAL_THEME_PACKAGE = '@adea-ai/themes' as const\nexport const CANONICAL_THEME_VERSION = '${themeVersion}' as const\nexport const CANONICAL_THEME_COLOR_VALUES = ${JSON.stringify(colors)} as const\nexport const CANONICAL_THEME_DATA = ${JSON.stringify(encodedVariants, null, 2)} as const\n`
const cssSource = `/** Generated from the isolated @adea-ai/themes ${themeVersion} records. */\nexport const CANONICAL_THEME_CSS_DATA = ${JSON.stringify(cssTokens, null, 2)} as const satisfies Record<string, Readonly<Record<string, string>>>\n\nexport function canonicalThemeCssTokens(id: keyof typeof CANONICAL_THEME_CSS_DATA): Record<string, string> {\n  return Object.freeze({ ...CANONICAL_THEME_CSS_DATA[id] })\n}\n`

function formatGenerated(generatedSource: string, output: URL): string {
  const result = Bun.spawnSync({
    cmd: ['bunx', 'oxfmt', '--stdin-filepath', output.pathname],
    stdin: Buffer.from(generatedSource),
  })
  if (result.exitCode !== 0) {
    throw new Error(`could not format generated ${output.pathname}`)
  }
  return result.stdout.toString()
}

const formattedSource = formatGenerated(source, OUTPUT)
const formattedCssSource = formatGenerated(cssSource, CSS_OUTPUT)

async function writeOrCheck(output: URL, generatedSource: string, name: string): Promise<void> {
  if (CHECK_ONLY) {
    const existing = await Bun.file(output).text()
    if (existing !== generatedSource) {
      throw new Error(`${name} is stale; run bun run themes:generate`)
    }
    return
  }
  await Bun.write(output, generatedSource)
}

await writeOrCheck(OUTPUT, formattedSource, 'canonical-theme-data.ts')
await writeOrCheck(CSS_OUTPUT, formattedCssSource, 'canonical-theme-css-data.ts')
