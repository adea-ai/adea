/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 */
import { builtinThemes, type ThemeVariant } from '@adea-ai/ui/lib/themes'

import { customUiVariants } from './custom-theme-library'

/**
 * Every selectable theme: the catalogue first, then imported themes.
 *
 * This is the one place the app reads the whole catalogue (`builtinThemes`), and it
 * is a module of its own on purpose: the appearance editor imports it from its lazy
 * chunk. Left in `custom-theme-library.ts`, which the shell's provider imports at
 * start-up, it would keep the 34-theme catalogue in the start-up closure (ADR 0014).
 */
export function themeRegistry(): readonly ThemeVariant[] {
  const custom = customUiVariants()
  return custom.length > 0 ? [...builtinThemes, ...custom] : builtinThemes
}
