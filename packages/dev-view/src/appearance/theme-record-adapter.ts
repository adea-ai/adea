/*
 * Published AppearanceEditor bridge.
 *
 * @adea-ai/ui owns the presentation and @adea-ai/themes owns canonical
 * catalogue values. Adea keeps its six accepted preference IDs and the local
 * ThemeProvider; this adapter projects only the identity and preview palette
 * fields read by the editor.
 */
import type { AdeaTheme, AdeaThemeRecord } from '@adea-ai/themes'

import {
  builtinThemeRegistry,
  deriveAccentRoles,
  normalizeAccentValue,
  type ThemeVariant,
} from '@adea-ai/app-ui/components/appearance'

type PreviewColors = Readonly<
  Pick<AdeaTheme['colors'], 'background' | 'foreground' | 'surface' | 'border' | 'accent'>
>

type AppearanceThemePreview = Readonly<
  Pick<AdeaTheme, 'id' | 'name' | 'appearance'> & { colors: PreviewColors }
>

type AppearanceThemeOption = Readonly<Pick<AdeaThemeRecord, 'id' | 'name' | 'appearance'>>

/** Exactly the IDs the local V2 preference model accepts, projected for the picker. */
export const appearanceThemeRecords: readonly AppearanceThemeOption[] = Object.freeze(
  builtinThemeRegistry
    .filter(
      (variant) =>
        variant.id === 'adea-light' ||
        variant.id === 'adea-dark' ||
        variant.id.startsWith('slate-') ||
        variant.id.startsWith('contrast-')
    )
    .map(({ id, name, appearance }) => ({ id, name, appearance }))
)

const appearanceThemeIds = new Set(appearanceThemeRecords.map(({ id }) => id))

function previewForTheme(variant: ThemeVariant): AppearanceThemePreview {
  return {
    id: variant.id,
    name: variant.name,
    appearance: variant.appearance,
    colors: {
      background: variant.colors.background,
      foreground: variant.colors.foreground,
      surface: variant.colors.card,
      border: variant.colors.border,
      accent: variant.colors.primary,
    },
  }
}

/** Resolve a selected local ID to the exact fields the external editor reads. */
export function appearanceThemeForPreview(
  variant: ThemeVariant,
  accent: string
): AppearanceThemePreview {
  const preview = previewForTheme(variant)

  if (!appearanceThemeIds.has(variant.id) || accent === 'theme') return preview

  const acceptedVariant = builtinThemeRegistry.find((candidate) => candidate.id === variant.id)!
  return {
    ...preview,
    colors: {
      ...preview.colors,
      accent: deriveAccentRoles(accent, acceptedVariant).primary,
    },
  }
}

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
