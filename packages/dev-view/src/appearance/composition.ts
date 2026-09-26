/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 *
 * Appearance preview composition retained for the Adea host adapter. The
 * published AppearanceEditor owns mode, accent, surface, and row presentation;
 * this module only resolves the live light/dark preview variants from Adea's
 * accepted preference IDs.
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 */
import {
  builtinThemeRegistry,
  resolveThemeVariant,
  type AppearancePreferencesV2,
  type ThemeVariant,
} from '@adea-ai/app-ui/components/appearance'

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
