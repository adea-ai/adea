/*
 * Published AppearanceEditor bridge.
 *
 * @adea-ai/ui owns the presentation and @adea-ai/themes owns canonical
 * catalogue values. Adea keeps its six accepted preference IDs and the local
 * ThemeProvider; this adapter only translates the local compatibility records
 * into the published editor's preview shape.
 */
import type { AdeaTheme, AdeaThemeRecord } from '@adea-ai/themes'
import adeaDark from '@adea-ai/themes/themes/adea-dark'
import adeaLight from '@adea-ai/themes/themes/adea-light'

import {
  builtinThemeRegistry,
  deriveAccentRoles,
  normalizeAccentValue,
  type ThemeVariant,
} from '@adea-ai/app-ui/components/appearance'

const compatibilityProvenance = {
  project: 'Adea app compatibility variants',
  url: 'https://github.com/adea-ai/adea',
  license: 'Apache-2.0',
} as const

function ansiRamp(variant: ThemeVariant): AdeaTheme['ansi'] {
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = variant.terminal.ansi
  return {
    black: black!,
    red: red!,
    green: green!,
    yellow: yellow!,
    blue: blue!,
    magenta: magenta!,
    cyan: cyan!,
    white: white!,
    brightBlack: brightBlack!,
    brightRed: brightRed!,
    brightGreen: brightGreen!,
    brightYellow: brightYellow!,
    brightBlue: brightBlue!,
    brightMagenta: brightMagenta!,
    brightCyan: brightCyan!,
    brightWhite: brightWhite!,
  }
}

/**
 * The compatibility variants predate the published semantic schema. The
 * AppearanceEditor reads only the surface, text, border, and accent preview
 * roles; warning/info are explicit compatibility fallbacks because those roles
 * do not exist in Adea's established local variant shape.
 */
function compatibilityRecord(variant: ThemeVariant): AdeaThemeRecord {
  const colors = variant.colors
  const theme: AdeaTheme = {
    id: variant.id,
    name: variant.name,
    appearance: variant.appearance,
    colors: {
      background: colors.background,
      foreground: colors.foreground,
      surface: colors.card,
      surfaceElevated: colors.popover,
      surfaceHover: colors.accent,
      surfaceActive: colors.border,
      border: colors.border,
      borderMuted: colors.border,
      text: colors.foreground,
      textMuted: colors.mutedForeground,
      textSubtle: colors.mutedForeground,
      accent: colors.primary,
      accentForeground: colors.primaryForeground,
      success: colors.success,
      warning: colors.accent,
      error: colors.destructive,
      info: colors.accent,
    },
    ansi: ansiRamp(variant),
    cursor: variant.terminal.cursor,
    selection: variant.terminal.selection,
  }
  return {
    ...theme,
    family: variant.familyId,
    familyLabel: variant.familyName,
    label: variant.name,
    description: `${variant.name} compatibility variant retained for the Adea preference schema.`,
    provenance: compatibilityProvenance,
    tags: ['compatibility', variant.appearance],
  }
}

const compatibilityRecords = builtinThemeRegistry
  .filter((variant) => variant.id.startsWith('slate-') || variant.id.startsWith('contrast-'))
  .map(compatibilityRecord)

const canonicalRecords = [adeaLight, adeaDark] as const

/** Exactly the IDs the local V2 preference model accepts. */
export const appearanceThemeRecords: readonly AdeaThemeRecord[] = Object.freeze([
  adeaLight,
  adeaDark,
  ...compatibilityRecords,
])

const recordById = new Map(appearanceThemeRecords.map((record) => [record.id, record]))

function withAccent(theme: AdeaTheme, accent: string): AdeaTheme {
  if (accent === 'theme') return theme
  const roles = deriveAccentRoles(
    accent,
    builtinThemeRegistry.find((variant) => variant.id === theme.id)!
  )
  return {
    ...theme,
    colors: {
      ...theme.colors,
      accent: roles.primary,
      accentForeground: roles.onPrimary,
    },
  }
}

/** Resolve a selected local ID to the external editor's raw preview contract. */
export function appearanceThemeForPreview(variant: ThemeVariant, accent: string): AdeaTheme {
  const record = recordById.get(variant.id)
  if (!record) return compatibilityRecord(variant)
  return withAccent(record, accent)
}

/** The two canonical records remain published values, without local literals. */
export const canonicalAppearanceThemes = canonicalRecords

export type AccentDraftValidation = Readonly<{
  value?: string
  error?: string
}>

/** Preserve the host's invalid-input behavior while feeding the pure editor. */
export function normalizeCustomAccent(value: string, background: string): AccentDraftValidation {
  const normalized = normalizeAccentValue(value, background)
  if (normalized === undefined) {
    return { error: `“${value}” is not a hex color such as #2563eb.` }
  }
  return { value: normalized }
}
