/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 *
 * Appearance page composition helpers substantially translated from Zeron
 * crates/ui/src/settings/appearance.rs, revision
 * 30a9a9537c5ec96226c87f4bf349b6f77c5dfb59: the mode card set, the
 * `accent_helper` and `surface_helper` row copy, the accent selection
 * classifier behind the swatch row, and the per-card variant resolution that
 * keeps the mode miniatures live against the draft. Modified for Adea's
 * translucent surface capability (the donor's ThemeDefault pole has no Adea
 * model value; the translucent slot carries that end of the control) and the
 * custom accent selection the donor lacks.
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 */
import {
  accentPresets,
  accentPresetById,
  resolveThemeVariant,
  type AppearanceMode,
  type AppearancePreferencesV2,
  type SurfacePreference,
  type ThemeVariant,
  builtinThemeRegistry,
} from '@adea-ai/ui/components/appearance'

/** The mode cards, in donor order. */
export const modeCards: readonly { value: AppearanceMode; label: string }[] = Object.freeze([
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
])

/** The segmented glass control, soft-to-hard like the donor's chips. */
export const surfaceChoices: readonly {
  value: SurfacePreference
  label: string
  helper: string
}[] = Object.freeze([
  {
    value: 'translucent',
    label: 'Translucent',
    helper: 'Native window vibrancy where the platform supports it; tokenized frost elsewhere.',
  },
  { value: 'frosted', label: 'Frosted', helper: 'Theme-colored glass where supported.' },
  { value: 'opaque', label: 'Opaque', helper: 'Solid surfaces for every theme.' },
])

/**
 * The accent row's helper copy (donor `accent_helper`): what the current
 * selection recolors, phrased per selection kind.
 */
export function accentHelperText(accent: string): string {
  if (accent === 'theme') return 'Theme default · Uses the palette’s intended color.'
  const preset = accentPresetById(accent)
  if (preset) return `${preset.label} · Controls, glyphs, selections, code, and activity.`
  return 'Custom color · Controls, glyphs, selections, code, and activity.'
}

/** The glass row's helper copy for the active chip (donor `surface_helper`). */
export function surfaceHelperText(surface: SurfacePreference): string {
  return surfaceChoices.find((choice) => choice.value === surface)!.helper
}

/**
 * Which swatch the accent selection highlights: `'theme'`, a preset id, or
 * `'custom'` for any validated hex color.
 */
export function accentSwatchSelection(accent: string): string {
  if (accent === 'theme') return 'theme'
  if (accentPresets.some((preset) => preset.id === accent)) return accent
  return 'custom'
}

/**
 * The variants behind the mode miniatures: resolved per appearance from the
 * draft so the System split, Light, and Dark cards track unsaved theme picks
 * the same instant the real chrome does.
 */
export function draftVariants(preferences: AppearancePreferencesV2): {
  light: ThemeVariant
  dark: ThemeVariant
} {
  return {
    light: resolveThemeVariant(builtinThemeRegistry, preferences, 'light'),
    dark: resolveThemeVariant(builtinThemeRegistry, preferences, 'dark'),
  }
}
