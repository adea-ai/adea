import type { ThemeVariant } from './appearance'
import { CANONICAL_THEME_COLORS, CANONICAL_THEME_DATA } from './canonical-theme-data'

/** The published IDs that are also accepted by Adea's v2 preference schema. */
export const CANONICAL_ADEA_THEME_IDS = ['adea-light', 'adea-dark'] as const

type CanonicalAdeaThemeId = (typeof CANONICAL_ADEA_THEME_IDS)[number]
type CanonicalThemeRecord = readonly [readonly [string, string], string, string, string]

const COLOR_KEYS =
  'background foreground card cardForeground popover popoverForeground primary primaryForeground secondary secondaryForeground muted mutedForeground accent accentForeground destructive success border input ring'.split(
    ' '
  )
const EDITOR_KEYS =
  'keyword string number comment function variable type tag attribute operator heading link diffAdd diffDelete diffHunk searchMatch'.split(
    ' '
  )

function palette(values: string) {
  return Array.from(values, (value) => {
    const index = value.charCodeAt(0) - 48
    return '#' + CANONICAL_THEME_COLORS.slice(index * 6, index * 6 + 6)
  })
}

function makeVariant(record: CanonicalThemeRecord, id: CanonicalAdeaThemeId): ThemeVariant {
  const [metadata, colorValues, terminalValues, editorValues] = record
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
    familyId: 'adea',
    familyName: 'Adea',
    name: metadata[0]!,
    appearance: metadata[1] as ThemeVariant['appearance'],
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
export function canonicalThemeVariant(id: CanonicalAdeaThemeId): ThemeVariant {
  return makeVariant(CANONICAL_THEME_DATA[id] as unknown as CanonicalThemeRecord, id)
}

export const canonicalAdeaThemeRegistry: readonly ThemeVariant[] = Object.freeze([
  canonicalThemeVariant('adea-light'),
  canonicalThemeVariant('adea-dark'),
])
