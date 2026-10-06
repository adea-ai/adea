import { accentPresetById, deriveAccentRoles, themeRegistry, type AccentRoles } from './appearance'

/**
 * The accent roles a workspace paints over the active theme variant, or
 * `undefined` when the workspace keeps the theme's own accent (or the variant
 * is unknown). Values come from the theme catalogue through the same
 * contrast-gated derivation the appearance editor uses; nothing is authored
 * here.
 */
export function workspaceAccentRoles(
  accent: string | null,
  variantId: string
): AccentRoles | undefined {
  if (accent === null || !accentPresetById(accent)) return undefined
  const variant = themeRegistry().find(({ id }) => id === variantId)
  if (!variant) return undefined
  const roles = deriveAccentRoles(accent, variant)
  return roles.overrides ? roles : undefined
}

const ROLE_PROPERTIES = [
  '--primary',
  '--primary-foreground',
  '--primary-hover',
  '--primary-subtle',
  '--ring',
] as const

/**
 * Scope a workspace accent to one element and its descendants by overriding
 * the primary roles as custom properties, so `bg-primary`, `text-primary` and
 * the focus ring inside it follow the workspace. Clearing (a `null` accent)
 * removes the overrides and the element inherits the app accent again.
 */
export function paintWorkspaceAccent(
  element: HTMLElement,
  accent: string | null,
  variantId: string
): void {
  const roles = workspaceAccentRoles(accent, variantId)
  if (!roles) {
    for (const property of ROLE_PROPERTIES) element.style.removeProperty(property)
    return
  }
  element.style.setProperty('--primary', roles.primary)
  element.style.setProperty('--primary-foreground', roles.onPrimary)
  element.style.setProperty('--primary-hover', roles.strong)
  // The tint follows the same mix the published accent blocks use.
  element.style.setProperty(
    '--primary-subtle',
    `color-mix(in oklch, ${roles.primary} 16%, transparent)`
  )
  element.style.setProperty('--ring', roles.ring)
}
