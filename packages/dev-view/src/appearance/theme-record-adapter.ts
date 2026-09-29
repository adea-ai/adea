/*
 * Published AppearanceEditor bridge.
 *
 * @adea-ai/ui owns the presentation and @adea-ai/themes owns canonical
 * catalogue values. Adea keeps its V2 preference model and the local
 * ThemeProvider; this adapter projects the generated compatibility registry
 * into the published editor's preview shape. The editor-floor exclusions
 * (see canonical-theme-data) never appear here, so a stored selection for one
 * falls back to the appearance default like any unknown id.
 */
import type { AdeaTheme, AdeaThemeRecord } from '@adea-ai/themes'
import adeaDark from '@adea-ai/themes/themes/adea-dark'
import adeaLight from '@adea-ai/themes/themes/adea-light'

import { CANONICAL_THEME_META } from '@adea-ai/app-ui/components/canonical-theme-meta'
import {
  builtinThemeRegistry,
  customThemeVariants,
  deriveAccentRoles,
  normalizeAccentValue,
  themeRegistry,
  type ThemeVariant,
} from '@adea-ai/app-ui/components/appearance'

/** Every picker record is a published catalogue theme; the catalogue carries
 * the per-family upstream provenance and licenses (see its NOTICE). */
const catalogueProvenance = {
  project: 'Adea themes catalogue',
  url: 'https://github.com/adea-ai/themes',
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
 * Project a generated variant into the editor's record shape. The AppearanceEditor
 * reads only the surface, text, border, and accent preview roles; warning/info
 * are explicit fallbacks because those roles do not exist in Adea's established
 * local variant shape.
 */
function catalogueRecord(variant: ThemeVariant): AdeaThemeRecord {
  const colors = variant.colors
  const meta = CANONICAL_THEME_META[variant.id as keyof typeof CANONICAL_THEME_META]
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
    label: meta?.label ?? variant.name,
    description:
      meta?.description ??
      (variant.familyId === 'imported'
        ? `${variant.name}, imported into your library.`
        : `${variant.name} published theme.`),
    provenance: meta?.provenance ?? catalogueProvenance,
    tags:
      meta?.tags ??
      (variant.familyId === 'imported' ? ['imported', variant.appearance] : [variant.appearance]),
  }
}

const catalogueRecords = builtinThemeRegistry
  .filter((variant) => variant.id !== adeaLight.id && variant.id !== adeaDark.id)
  .map(catalogueRecord)

/** Imported themes, re-projected on every registry change. */
export function customThemeRecords(): readonly AdeaThemeRecord[] {
  return customThemeVariants().map(catalogueRecord)
}

/** The built-in registry led by the published pair; import lives separately. */
export const appearanceThemeRecords: readonly AdeaThemeRecord[] = Object.freeze([
  adeaLight,
  adeaDark,
  ...catalogueRecords,
])

/** Every selectable record: built-ins first, then imported themes. */
export function allThemeRecords(): readonly AdeaThemeRecord[] {
  return [...appearanceThemeRecords, ...customThemeRecords()]
}

const recordById = new Map(appearanceThemeRecords.map((record) => [record.id, record]))

function withAccent(theme: AdeaTheme, accent: string): AdeaTheme {
  if (accent === 'theme') return theme
  const roles = deriveAccentRoles(
    accent,
    themeRegistry().find((variant) => variant.id === theme.id)!
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
  if (!record) return catalogueRecord(variant)
  return withAccent(record, accent)
}

/** The two canonical records remain published values, without local literals. */
export const canonicalAppearanceThemes = [adeaLight, adeaDark] as const

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
