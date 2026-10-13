/*
 * Published AppearanceEditor bridge.
 *
 * @adea-ai/ui owns the presentation and @adea-ai/themes owns canonical
 * catalogue values. Adea keeps its V2 preference model; this adapter hands the
 * published editor the catalogue's own theme records (the shared ThemeProvider
 * paints from the same catalogue), plus a record per imported theme.
 */
import type { AdeaTheme, AdeaThemeRecord } from '@adea-ai/themes'
import { getAccent } from '@adea-ai/themes'
import adeaDark from '@adea-ai/themes/themes/adea-dark'
import adeaLight from '@adea-ai/themes/themes/adea-light'
import { colorToHex, normalizeAccentValue, parseColor } from '@adea-ai/ui/lib/accent-roles'
import {
  accentRolesForSelection,
  themeRecordById,
  themeRecords,
  type ThemeVariant,
} from '@adea-ai/ui/lib/themes'

import { APPEARANCE_ACCENT_CONTRAST_FLOOR } from '@adea-ai/app-ui/components/appearance-codec'
import {
  customThemeVariants,
  storedVariantRecord,
} from '@adea-ai/app-ui/components/custom-theme-library'
import { themeRegistry } from '@adea-ai/app-ui/components/theme-registry'

/** The published blue preset is the host's default custom accent. */
export const DEFAULT_CUSTOM_ACCENT = getAccent('blue')?.light ?? adeaLight.colors.accent

/** Imported themes, re-projected on every registry change. */
export function customThemeRecords(): readonly AdeaThemeRecord[] {
  return customThemeVariants().map(storedVariantRecord)
}

/** The built-in catalogue led by the published pair; import lives separately. */
export const appearanceThemeRecords: readonly AdeaThemeRecord[] = Object.freeze([
  adeaLight,
  adeaDark,
  ...themeRecords.filter((record) => record.id !== adeaLight.id && record.id !== adeaDark.id),
])

/** Every selectable record: built-ins first, then imported themes. */
export function allThemeRecords(): readonly AdeaThemeRecord[] {
  return [...appearanceThemeRecords, ...customThemeRecords()]
}

function withAccent(
  theme: AdeaTheme,
  accent: string,
  pair: { lightThemeId: string; darkThemeId: string } | undefined
): AdeaTheme {
  if (accent === 'theme') return theme
  const variant = themeRegistry().find((candidate) => candidate.id === theme.id)
  // The 3:1 floor needs the variant's background. A record whose variant has
  // vanished previews its own accent rather than throwing mid-interaction.
  if (!variant) return theme
  const roles = accentRolesForSelection(accent, theme.appearance, pair, {
    background: variant.colors.background,
    floor: APPEARANCE_ACCENT_CONTRAST_FLOOR,
    variantId: variant.id,
  })
  if (!roles) return theme
  return {
    ...theme,
    colors: {
      ...theme.colors,
      accent: roles.primary,
      accentForeground: roles.primaryForeground,
    },
  }
}

/**
 * Resolve a selected local ID to the external editor's raw preview contract.
 * `pair` is the draft's light/dark theme ids, which a theme-derived (`ansi-*`)
 * accent is read from.
 */
export function appearanceThemeForPreview(
  variant: ThemeVariant,
  accent: string,
  pair?: { lightThemeId: string; darkThemeId: string }
): AdeaTheme {
  // Imported themes have no catalogue record; their stored variant projects to
  // one on the spot, so every record takes the same accent overlay path.
  const record =
    themeRecordById(variant.id) ??
    customThemeRecords().find((candidate) => candidate.id === variant.id) ??
    (variant.appearance === 'dark' ? adeaDark : adeaLight)
  return withAccent(record, accent, pair)
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
    return { error: `“${value}” is not a hex color such as ${DEFAULT_CUSTOM_ACCENT}.` }
  }
  // Stored accents are opaque #rrggbb; an alpha channel is dropped.
  const parsed = parseColor(normalized)
  return { value: parsed ? colorToHex({ ...parsed, a: 255 }) : normalized }
}
