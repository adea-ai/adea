/**
 * Shortcut labels the support surfaces display.
 *
 * The one place that decides which glyph a surface advertises lives next to
 * the key caps it draws: `@adea-ai/ui`'s kbd module owns
 * `platformModifierKey` and `searchShortcutLabel`, so every surface that can
 * reach the shared library — including packages that must not import this one
 * (the Dev view, which the shell depends on) — draws the same chord. This
 * module keeps the shell's import surface stable and composes the one
 * shell-specific label on top of the shared primitives.
 */

import { platformModifierKey } from '@adea-ai/ui/components/ui/kbd'

export {
  platformModifierKey,
  searchShortcutKeyshortcuts,
  searchShortcutLabel,
} from '@adea-ai/ui/components/ui/kbd'

/** The settings chord label: the platform modifier followed by a comma. */
export function settingsShortcutLabel(platform?: string): string {
  return `${platformModifierKey(platform)},`
}
