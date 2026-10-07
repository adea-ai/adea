/**
 * Shortcut labels the support surfaces display.
 *
 * Every global chord binds `(metaKey || ctrlKey)`, so the working key is the
 * platform's command modifier wherever the app runs — but Apple platforms
 * draw it as ⌘ and everyone else spells it Ctrl. The label helpers here are
 * the one place that decides which glyph a surface advertises, so the rail,
 * the account menu, and the Help Center cannot drift apart.
 */

/** The modifier glyph the running OS renders for Meta: ⌘ on Apple platforms, Ctrl elsewhere. */
export function platformModifierKey(platform?: string): '⌘' | 'Ctrl' {
  // The guard keeps server renders honest: no navigator means no Apple
  // platform string, so they fall back to the spelled-out modifier.
  const browserPlatform = platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform)
  return /Mac|iPhone|iPad|iPod/i.test(browserPlatform) ? '⌘' : 'Ctrl'
}

/** The settings chord label: the platform modifier followed by a comma. */
export function settingsShortcutLabel(platform?: string): string {
  return `${platformModifierKey(platform)},`
}

/** The workspace search chord label as the rail's hover text draws it: the
 *  platform modifier plus K (`⌘K`, or `Ctrl+K` where ⌘ does not exist). */
export function searchShortcutLabel(platform?: string): string {
  return platformModifierKey(platform) === '⌘' ? '⌘K' : 'Ctrl+K'
}
