import type { ThemeVariant } from './appearance'
import { CANONICAL_THEME_COLOR_VALUES, CANONICAL_THEME_DATA } from './canonical-theme-data'

type CanonicalThemeId = Extract<keyof typeof CANONICAL_THEME_DATA, string>

/**
 * Published IDs retained by Adea's v2 appearance preferences, in generated
 * order (the Adea pair leads, then the catalogue). The catalogue's editor-floor
 * exclusions never enter the registry, so a stored selection for one falls
 * back to the appearance's default exactly like an unknown id.
 */
export const CANONICAL_THEME_IDS: readonly CanonicalThemeId[] = Object.keys(
  CANONICAL_THEME_DATA
) as CanonicalThemeId[]

/** The original Adea pair remains the built-in CSS default. */
export const CANONICAL_ADEA_THEME_IDS = ['adea-light', 'adea-dark'] as const

type CanonicalThemeRecord = readonly [
  readonly [string, string, string, string],
  string,
  string,
  string,
]

const COLOR_KEYS =
  'background foreground card cardForeground popover popoverForeground primary primaryForeground secondary secondaryForeground muted mutedForeground accent accentForeground destructive destructiveAction destructiveActionForeground success border input ring'.split(
    ' '
  )
const EDITOR_KEYS =
  'keyword string number comment function variable type tag attribute operator heading link diffAdd diffDelete diffHunk searchMatch'.split(
    ' '
  )

function palette(values: string) {
  return Array.from(values, (value) => {
    const index = value.charCodeAt(0) - 48
    const color = CANONICAL_THEME_COLOR_VALUES[index]
    if (!color) throw new Error(`generated theme color index ${index} is missing`)
    return color
  })
}

function makeVariant(record: CanonicalThemeRecord, id: CanonicalThemeId): ThemeVariant {
  const [metadata, colorValues, terminalValues, editorValues] = record
  const [name, appearance, familyId, familyName] = metadata
  const colorsValues = palette(colorValues)
  const terminalColorValues = palette(terminalValues)
  const editorColorValues = palette(editorValues)
  const colors = Object.freeze(
    Object.fromEntries(
      COLOR_KEYS.map((key, index) => [key, colorsValues[index]])
    ) as ThemeVariant['colors']
  )
  const ansi = Object.freeze(terminalColorValues.slice(2))
  const editor = Object.freeze(
    Object.fromEntries(
      EDITOR_KEYS.map((key, index) => [key, editorColorValues[index]])
    ) as ThemeVariant['editor']
  )
  const charts = Object.freeze({
    chart1: ansi[4],
    chart2: ansi[5],
    chart3: ansi[6],
    chart4: ansi[2],
    chart5: ansi[3],
    chart6: ansi[1],
  })
  return Object.freeze({
    id,
    familyId,
    familyName,
    name,
    appearance: appearance as ThemeVariant['appearance'],
    colors,
    terminal: Object.freeze({
      background: colors.background,
      foreground: colors.foreground,
      cursor: terminalColorValues[0]!,
      selection: terminalColorValues[1]!,
      ansi,
    }),
    editor,
    charts,
  })
}

/** Convert one generated published record into Adea's established runtime shape. */
export function canonicalThemeVariant(id: CanonicalThemeId): ThemeVariant {
  const record = CANONICAL_THEME_DATA[id] as unknown as CanonicalThemeRecord
  return makeVariant(record, id)
}

export const canonicalThemeRegistry: readonly ThemeVariant[] = Object.freeze(
  CANONICAL_THEME_IDS.map(canonicalThemeVariant)
)

export const canonicalAdeaThemeRegistry: readonly ThemeVariant[] = Object.freeze(
  CANONICAL_ADEA_THEME_IDS.map(canonicalThemeVariant)
)
