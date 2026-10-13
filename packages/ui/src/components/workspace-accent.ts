import { getAccent } from '@adea-ai/themes'
import {
  ACCENT_PAINT_PROPERTIES,
  paintAccentRoles,
  type AccentRoles,
} from '@adea-ai/ui/lib/accent-roles'
import { accentRolesForSelection } from '@adea-ai/ui/lib/themes'

import { APPEARANCE_ACCENT_CONTRAST_FLOOR } from './appearance-codec'
import { themeRegistry } from './custom-theme-library'

/**
 * The accent roles a workspace paints over the active theme variant, or
 * `undefined` when the workspace keeps the theme's own accent (or the variant
 * is unknown). Values come from the theme catalogue through the same
 * contrast-gated derivation the document uses; nothing is authored here.
 */
export function workspaceAccentRoles(
  accent: string | null,
  variantId: string
): AccentRoles | undefined {
  if (accent === null || !getAccent(accent)) return undefined
  const variant = themeRegistry().find(({ id }) => id === variantId)
  if (!variant) return undefined
  return accentRolesForSelection(accent, variant.appearance, undefined, {
    background: variant.colors.background,
    floor: APPEARANCE_ACCENT_CONTRAST_FLOOR,
    variantId: variant.id,
  })
}

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
  paintAccentRoles(element, workspaceAccentRoles(accent, variantId))
}

/**
 * Pin an element to the appearance accent: the primary roles as the document
 * element resolves them. A workspace accent painted on <body> (the active
 * workspace themes the app) would otherwise reach every descendant, so a
 * workspace without its own accent uses this to keep showing the appearance
 * accent instead of borrowing the active workspace's.
 */
export function paintAppearanceAccent(element: HTMLElement): void {
  // A node Solid cloned from a template but has not inserted yet (a dialog
  // header still mounting) belongs to the template's inert document, which
  // has no document element; the live document is the one it lands in.
  const root = getComputedStyle(
    element.ownerDocument.documentElement ?? globalThis.document.documentElement
  )
  for (const property of ACCENT_PAINT_PROPERTIES) {
    const value = root.getPropertyValue(property).trim()
    if (value) element.style.setProperty(property, value)
    else element.style.removeProperty(property)
  }
}
