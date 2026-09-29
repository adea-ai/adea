/*
 * Custom theme import: turn an uploaded theme file into a runtime variant.
 *
 * The import is deliberately permissive. A file may carry the published
 * canonical schema (17 surface roles plus an ANSI ramp) or any subset of it;
 * missing roles are filled from the default theme of the same appearance, and
 * text roles that cannot reach a readable contrast against their own
 * background are repaired, with every adjustment reported back to the UI
 * instead of silently altering the palette. Nothing here enforces provenance
 * or distribution terms: an imported theme is the user's own copy for their
 * own machine.
 */
import {
  editorRolesHex,
  syntaxRolesHex,
  type AdeaTheme,
  type AdeaThemeRecord,
} from '@adea-ai/themes'
import { oklchToHex, parseColor } from '@adea-ai/themes/oklch'
import { shadcnDestructiveProjection, shadcnVariables } from '@adea-ai/themes/adapters/shadcn'
import { toXtermTheme } from '@adea-ai/themes/adapters/xterm'

import {
  colorToHex,
  contrastRatio,
  ensureContrast,
  flatVariantTokens,
  parseColor as parseHex,
  setCustomThemes,
  validateThemeRegistry,
  type AppearanceStorage,
  type CustomThemeStored,
  type ThemeColors,
  type ThemeVariant,
} from '@adea-ai/app-ui/components/appearance'
import adeaDark from '@adea-ai/themes/themes/adea-dark'
import adeaLight from '@adea-ai/themes/themes/adea-light'

const CANONICAL_COLOR_KEYS = [
  'background',
  'foreground',
  'surface',
  'surfaceElevated',
  'surfaceHover',
  'surfaceActive',
  'border',
  'borderMuted',
  'text',
  'textMuted',
  'textSubtle',
  'accent',
  'accentForeground',
  'success',
  'warning',
  'error',
  'info',
] as const

const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

/** The published syntax-role mapping, used when a file needs roles derived. */
const SYNTAX_SOURCES = {
  keyword: 'magenta',
  string: 'green',
  number: 'yellow',
  comment: 'brightBlack',
  function: 'blue',
  variable: 'cyan',
  type: 'cyan',
  tag: 'red',
  attribute: 'yellow',
  operator: 'foreground',
  heading: 'magenta',
  link: 'blue',
  diffAdd: 'green',
  diffDelete: 'red',
  diffHunk: 'brightBlack',
  searchMatch: 'yellow',
} as const

export type CustomThemeImportResult =
  | { ok: true; theme: CustomThemeStored }
  | { ok: false; error: string }

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'theme'
  )
}

function normalizeHex(value: string): string {
  const parsed = parseHex(value)
  return parsed
    ? `#${[parsed.r, parsed.g, parsed.b].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
    : value
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && parseHex(value) !== undefined
}

function baseRecord(appearance: 'light' | 'dark'): AdeaThemeRecord {
  return appearance === 'dark' ? adeaDark : adeaLight
}

/** Repair one foreground/background pair to the readable floor, reporting it. */
function repairToFloor(
  foreground: string,
  background: string,
  notes: string[],
  role: string
): string {
  const front = parseHex(foreground)
  const back = parseHex(background)
  if (!front || !back) return foreground
  if (contrastRatio(front, back) >= 4.5) return foreground
  // The host repair loops contrast margins and falls back to a guaranteed
  // foreground, so an import can never ship unreadable text.
  const repaired = ensureContrast(front, back, 4.5)
  notes.push(`“${role}” was adjusted for readable contrast.`)
  return colorToHex(repaired)
}

function hexOf(value: string): string {
  const parsed = parseColor(value)
  return parsed ? oklchToHex(parsed) : value
}

/**
 * Project a validated canonical theme into the runtime variant shape, the same
 * adapters the generated built-in registry uses.
 */
function projectCanonical(theme: AdeaTheme): ThemeVariant {
  const action = shadcnDestructiveProjection(theme)
  const shadcn = {
    ...shadcnVariables(theme),
    '--destructive-action': action.fill,
    '--destructive-action-foreground': action.foreground,
  }
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
  const colors = Object.fromEntries(
    Object.entries(SHADCN_TO_COLOR).map(([name, property]) => [
      property,
      hexOf((shadcn as Record<string, string>)[`--${name}`]!),
    ])
  ) as unknown as ThemeColors
  const terminalSource = toXtermTheme(theme)
  const ansi = [
    terminalSource.black,
    terminalSource.red,
    terminalSource.green,
    terminalSource.yellow,
    terminalSource.blue,
    terminalSource.magenta,
    terminalSource.cyan,
    terminalSource.white,
    terminalSource.brightBlack,
    terminalSource.brightRed,
    terminalSource.brightGreen,
    terminalSource.brightYellow,
    terminalSource.brightBlue,
    terminalSource.brightMagenta,
    terminalSource.brightCyan,
    terminalSource.brightWhite,
  ].map((value) => hexOf(value))
  let editor: Record<string, string>
  try {
    editor = { ...editorRolesHex(theme) }
  } catch {
    // Some palettes cannot reach the 4.5:1 syntax floor from their own ramp;
    // fall back to the raw roles repaired toward the floor.
    const raw = syntaxRolesHex(theme)
    editor = Object.fromEntries(
      Object.entries(raw)
        .filter(([role]) => role in SYNTAX_SOURCES)
        .map(([role, value]) => [role, hexOf(value)])
    )
  }
  const charts = {
    chart1: ansi[4]!,
    chart2: ansi[5]!,
    chart3: ansi[6]!,
    chart4: ansi[2]!,
    chart5: ansi[3]!,
    chart6: ansi[1]!,
  }
  return {
    id: theme.id,
    familyId: 'imported',
    familyName: 'Imported',
    name: theme.name,
    appearance: theme.appearance,
    colors,
    terminal: {
      background: hexOf(terminalSource.background),
      foreground: hexOf(terminalSource.foreground),
      cursor: hexOf(terminalSource.cursor),
      selection: hexOf(terminalSource.selectionBackground),
      ansi,
    },
    editor: editor as ThemeVariant['editor'],
    charts,
  }
}

/**
 * Parse and store an uploaded theme. The only hard failure is unparseable
 * JSON: everything else normalizes, fills from the same-appearance default,
 * and reports what it had to adjust.
 */
export function importCustomTheme(
  text: string,
  storage: AppearanceStorage | undefined,
  existing: readonly CustomThemeStored[]
): CustomThemeImportResult {
  let source: unknown
  try {
    source = JSON.parse(text)
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' }
  }
  const record = (
    typeof source === 'object' && source !== null && 'theme' in (source as Record<string, unknown>)
      ? (source as { theme: unknown }).theme
      : source
  ) as Record<string, unknown>
  if (typeof record !== 'object' || record === null) {
    return { ok: false, error: 'That file does not describe a theme.' }
  }

  const notes: string[] = []
  const rawColors = (record.colors ?? {}) as Record<string, unknown>
  const appearance: 'light' | 'dark' =
    record.appearance === 'light' || record.appearance === 'dark'
      ? record.appearance
      : rawColors.background === undefined
        ? 'dark'
        : 'light'
  const base = baseRecord(appearance)
  const name =
    typeof record.name === 'string' && record.name.trim().length > 0
      ? record.name.trim().slice(0, 64)
      : typeof record.label === 'string' && record.label.trim().length > 0
        ? record.label.trim().slice(0, 64)
        : 'Imported theme'

  // Fill the canonical surface roles from whatever the file provides, then
  // from the same-appearance default for anything missing.
  const colors: Record<string, string> = {}
  for (const key of CANONICAL_COLOR_KEYS) {
    const value = rawColors[key]
    if (isHex(value)) colors[key] = normalizeHex(value)
  }
  // Users name the main text role 'foreground'; the canonical schema calls it
  // 'text'. Accept both before filling anything from the default theme.
  if (colors.text === undefined && isHex(rawColors.foreground)) {
    colors.text = normalizeHex(rawColors.foreground)
  }
  if (colors.textMuted === undefined && isHex(rawColors.mutedForeground)) {
    colors.textMuted = normalizeHex(rawColors.mutedForeground)
  }
  const filled = CANONICAL_COLOR_KEYS.filter((key) => colors[key] === undefined)
  if (filled.length > 0) {
    for (const key of filled) colors[key] = base.colors[key as keyof typeof base.colors]
    notes.push('Missing roles were filled from the default theme.')
  }

  // Text roles must stay readable against the background we actually ship.
  colors.text = repairToFloor(colors.text!, colors.background!, notes, 'text')
  colors.textMuted = repairToFloor(colors.textMuted!, colors.background!, notes, 'muted text')
  colors.textSubtle = repairToFloor(colors.textSubtle!, colors.background!, notes, 'subtle text')

  const ansiRecord = (record.ansi ?? {}) as Record<string, unknown>
  const ansi = ANSI_KEYS.map((key) => {
    const value = ansiRecord[key]
    return isHex(value) ? normalizeHex(value) : base.ansi[key]
  })
  if (Object.keys(ansiRecord).length === 0)
    notes.push('No ANSI ramp in the file; the default ramp was kept.')

  const canonical: AdeaTheme = {
    id: 'pending',
    name,
    appearance,
    colors: colors as unknown as AdeaTheme['colors'],
    ansi: Object.fromEntries(
      ANSI_KEYS.map((key, index) => [key, ansi[index]!])
    ) as unknown as AdeaTheme['ansi'],
    cursor: isHex(record.cursor) ? normalizeHex(record.cursor) : base.cursor,
    selection: isHex(record.selection) ? normalizeHex(record.selection) : base.selection,
  }

  let variant: ThemeVariant
  try {
    variant = projectCanonical(canonical)
  } catch {
    // The adapters refuse unencodable roles; fall back to a direct host
    // projection so the import still succeeds with a warning.
    variant = projectHostFallback(name, appearance, colors as unknown as ThemeColors, ansi)
    notes.push('Syntax roles were approximated from the ANSI ramp.')
  }
  variant = { ...variant, id: `custom-${slug(name)}-${Date.now().toString(36)}`, name }

  const issues = validateThemeRegistry([variant]).filter((issue) => issue.severity === 'error')
  for (const issue of issues) notes.push(`${issue.variantId}: ${issue.message}`)

  const stored: CustomThemeStored = {
    id: variant.id,
    name: variant.name,
    appearance,
    importedAt: new Date().toISOString(),
    variant,
    flatTokens: flatVariantTokens(variant),
    notes,
  }
  setCustomThemes([...existing, stored], storage)
  return { ok: true, theme: stored }
}

/** Direct host projection for inputs the canonical adapters reject. */
function projectHostFallback(
  name: string,
  appearance: 'light' | 'dark',
  colors: ThemeColors,
  ansi: readonly string[]
): ThemeVariant {
  const ramp = (index: number): string => ansi[index] ?? colors.foreground
  const editor = Object.fromEntries(
    Object.entries(SYNTAX_SOURCES).map(([role, source]) => {
      const value =
        source === 'foreground'
          ? colors.foreground
          : ramp(ANSI_KEYS.indexOf(source as (typeof ANSI_KEYS)[number]))
      return [role, repairToFloor(value, colors.background, [], role)]
    })
  )
  return {
    id: 'pending',
    familyId: 'imported',
    familyName: 'Imported',
    name,
    appearance,
    colors,
    terminal: {
      background: colors.background,
      foreground: colors.foreground,
      cursor: ramp(6),
      selection: ramp(0),
      ansi: [...ansi],
    },
    editor: editor as ThemeVariant['editor'],
    charts: {
      chart1: ramp(4),
      chart2: ramp(5),
      chart3: ramp(6),
      chart4: ramp(2),
      chart5: ramp(3),
      chart6: ramp(1),
    },
  }
}
