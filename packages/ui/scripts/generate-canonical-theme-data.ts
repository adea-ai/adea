import adeaDarkTheme from '@adea-ai/themes/themes/adea-dark'
import adeaLightTheme from '@adea-ai/themes/themes/adea-light'
import { chartSeries, syntaxRolesHex } from '@adea-ai/themes'
import { oklchToHex, parseColor, repairContrast } from '@adea-ai/themes/oklch'
import { shadcnVariables } from '@adea-ai/themes/adapters/shadcn'
import { toXtermTheme } from '@adea-ai/themes/adapters/xterm'

const OUTPUT = new URL('../src/components/canonical-theme-data.ts', import.meta.url)
const CSS_OUTPUT = new URL('../src/components/canonical-theme-css-data.ts', import.meta.url)
const CHECK_ONLY = Bun.argv.includes('--check')
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

function makeRecord(theme: typeof adeaLightTheme) {
  const shadcn = shadcnVariables(theme)
  const colors = Object.fromEntries(
    Object.entries(SHADCN_TO_COLOR).map(([name, property]) => [
      property,
      hex(shadcn[`--${name}`]!, `--${name}`),
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
  const editorBackground = parseColor(colors.background)
  if (!editorBackground) throw new Error(`canonical ${theme.id} has no editor background`)
  const syntax = syntaxRolesHex(theme)
  const editor = Object.fromEntries(
    EDITOR_ROLES.map((role) => {
      const foreground = parseColor(syntax[role])
      if (!foreground) throw new Error(`canonical ${theme.id} is missing editor.${role}`)
      const repaired = repairContrast(foreground, editorBackground, 4.5)
      if (!repaired.satisfied) throw new Error(`cannot repair editor.${role} in ${theme.id}`)
      return [role, oklchToHex(repaired.color)]
    })
  )
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
      hex(shadcn[`--${name}`]!, `--${name}`),
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
  'adea-light': makeRecord(adeaLightTheme),
  'adea-dark': makeRecord(adeaDarkTheme),
}
const variants = Object.fromEntries(
  Object.entries(records).map(([id, record]) => {
    const variant = record.variant
    return [
      id,
      [
        [variant.name, variant.appearance],
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
).map((value) => value.slice(1))
const colorIndex = new Map(colors.map((value, index) => [`#${value}`, index]))
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
const source = `/** Generated from the isolated @adea-ai/themes 0.5.0 records. */\nexport const CANONICAL_THEME_PACKAGE = '@adea-ai/themes' as const\nexport const CANONICAL_THEME_VERSION = '0.5.0' as const\nexport const CANONICAL_THEME_COLORS = ${JSON.stringify(colors.join(''))} as const\nexport const CANONICAL_THEME_DATA = ${JSON.stringify(encodedVariants, null, 2)} as const\n`
const cssSource = `/** Generated from the isolated @adea-ai/themes 0.5.0 records. */\nexport const CANONICAL_THEME_CSS_DATA = ${JSON.stringify(cssTokens, null, 2)} as const satisfies Record<string, Readonly<Record<string, string>>>\n\nexport function canonicalThemeCssTokens(id: keyof typeof CANONICAL_THEME_CSS_DATA): Record<string, string> {\n  return Object.freeze({ ...CANONICAL_THEME_CSS_DATA[id] })\n}\n`

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
