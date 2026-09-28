import {
  chartSeries,
  editorRolesHex,
  getTheme,
  themeIds,
  type AdeaThemeRecord,
} from '@adea-ai/themes'
import { oklchToHex, parseColor } from '@adea-ai/themes/oklch'
import { shadcnVariables, shadcnDestructiveProjection } from '@adea-ai/themes/adapters/shadcn'
import { toXtermTheme } from '@adea-ai/themes/adapters/xterm'

const OUTPUT = new URL('../src/components/canonical-theme-data.ts', import.meta.url)
const CSS_OUTPUT = new URL('../src/components/canonical-theme-css-data.ts', import.meta.url)
const META_OUTPUT = new URL('../src/components/canonical-theme-meta.ts', import.meta.url)
const STYLESHEET_OUTPUT = new URL('../src/styles/canonical-themes.css', import.meta.url)
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

/** The default pair stays CSS-owned in `styles/theme.css`; every other
 * catalogue theme ships as a `[data-theme]` block and an inline-removable
 * runtime token map. */
const DEFAULT_THEME_IDS = new Set(['adea-light', 'adea-dark'])

/**
 * Catalogue themes whose published editor projection cannot reach the host's
 * 4.5:1 syntax floor even through the catalogue's own repair pass (upstream
 * derives `variable`/`operator` from light-theme ramps that collapse to white).
 * The catalogue's doctrine is to say so rather than ship them; Adea excludes
 * them until the projection can clear the floor. The tripwire below fails the
 * generation when the set changes, so a catalogue fix widens the registry
 * deliberately instead of silently.
 */
const EXPECTED_FLOOR_EXCLUSIONS = [
  'ayu-light',
  'catppuccin-latte',
  'everforest-light',
  'gruvbox-light',
  'rosepine-dawn',
  'solarized-light',
  'tokyonight-day',
] as const

/** The published catalogue is the picker's authority; the default pair leads. */
const catalogueIds = [
  ...DEFAULT_THEME_IDS,
  ...themeIds().filter((id) => !DEFAULT_THEME_IDS.has(id)),
]

const records: Record<string, ReturnType<typeof makeRecord>> = {}
const floorExclusions: string[] = []
for (const id of catalogueIds) {
  try {
    records[id] = makeRecord(publishedTheme(id))
  } catch (error) {
    floorExclusions.push(id)
    console.warn(`excluding ${id}: ${(error as Error).message}`)
  }
}
const unexpected = [
  ...floorExclusions.filter((id) => !EXPECTED_FLOOR_EXCLUSIONS.includes(id as never)),
  ...EXPECTED_FLOOR_EXCLUSIONS.filter((id) => !floorExclusions.includes(id)),
]
if (unexpected.length > 0) {
  throw new Error(
    `catalogue editor-floor exclusions changed (expected exactly ${EXPECTED_FLOOR_EXCLUSIONS.join(', ')}); update EXPECTED_FLOOR_EXCLUSIONS: ${unexpected.join(', ')}`
  )
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
/** Picker metadata for every catalogue theme; the variant tuples above carry
 * name/family already. Kept in its own module so only the lazy appearance
 * chunk pays for descriptions and provenance. */
const metaEntries = Object.fromEntries(
  Object.keys(records).map((id) => {
    const theme = publishedTheme(id)
    return [
      id,
      {
        label: theme.label,
        description: theme.description,
        provenance: theme.provenance,
        tags: [...theme.tags],
      },
    ]
  })
)
const stylesheet = Object.keys(records)
  .filter((id) => !DEFAULT_THEME_IDS.has(id))
  .map((id) => {
    const declarations = Object.entries(cssTokens[id]!)
      .map(([name, value]) => `  ${name}: ${value};`)
      .join('\n')
    return `[data-theme='${id}'] {\n${declarations}\n}\n`
  })
  .join('\n')
const source = `/** Generated from the isolated @adea-ai/themes ${themeVersion} records. */\nexport const CANONICAL_THEME_PACKAGE = '@adea-ai/themes' as const\nexport const CANONICAL_THEME_VERSION = '${themeVersion}' as const\n/** Catalogue ids absent from the data: the published editor projection cannot reach the host's 4.5:1 syntax floor for them yet. */\nexport const CANONICAL_FLOOR_EXCLUSIONS = ${JSON.stringify(floorExclusions)} as const\nexport const CANONICAL_THEME_COLOR_VALUES = ${JSON.stringify(colors)} as const\nexport const CANONICAL_THEME_DATA = ${JSON.stringify(encodedVariants, null, 2)} as const\n`
const cssSource = `/** Generated from the isolated @adea-ai/themes ${themeVersion} records. */\nexport const CANONICAL_THEME_CSS_DATA = ${JSON.stringify(cssTokens, null, 2)} as const satisfies Record<string, Readonly<Record<string, string>>>\n\nexport function canonicalThemeCssTokens(id: keyof typeof CANONICAL_THEME_CSS_DATA): Record<string, string> {\n  return Object.freeze({ ...CANONICAL_THEME_CSS_DATA[id] })\n}\n`
const metaSource = `/** Generated from the isolated @adea-ai/themes ${themeVersion} records. */\nexport const CANONICAL_THEME_META = ${JSON.stringify(metaEntries, null, 2)} as const satisfies Record<string, { label: string; description: string; provenance: { project: string; url: string; license: string; revision?: string; bootstrappedFrom?: readonly string[] }; tags: readonly string[] }>\n`
const stylesheetSource = `/* Generated from the isolated @adea-ai/themes ${themeVersion} records. The default\n   adea pair stays CSS-owned in theme.css; every other published theme applies\n   through its data-theme attribute so a stored selection paints correctly\n   before hydration. Do not edit; run bun run themes:generate. */\n\n${stylesheet}`

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
const formattedMetaSource = formatGenerated(metaSource, META_OUTPUT)
const formattedStylesheetSource = formatGenerated(stylesheetSource, STYLESHEET_OUTPUT)

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
await writeOrCheck(META_OUTPUT, formattedMetaSource, 'canonical-theme-meta.ts')
await writeOrCheck(STYLESHEET_OUTPUT, formattedStylesheetSource, 'canonical-themes.css')
