// The Dock and desktop icon colourway (https://github.com/adea-ai/brand). The
// packaged bundle's own icon is the white colourway (`icon.iconset`); the user
// can pick white, violet or black in Settings, and the pick is persisted in the
// workspace preferences next to `windowSurface`. The web mirrors the pick here
// through `desktop_app_icon_apply`, and the shell re-applies it at boot.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const APP_ICON_VARIANTS = ['white', 'violet', 'black'] as const
export type AppIconVariant = (typeof APP_ICON_VARIANTS)[number]
export const DEFAULT_APP_ICON: AppIconVariant = 'white'

export function isAppIconVariant(value: unknown): value is AppIconVariant {
  return typeof value === 'string' && (APP_ICON_VARIANTS as readonly string[]).includes(value)
}

/** The persisted pick; anything missing, unreadable or unknown is the default. */
export function appIconFor(dataDir: string): AppIconVariant {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(dataDir, 'desktop-state', 'preferences.json'), 'utf8')
    )
    const pick = (raw as { appIcon?: unknown }).appIcon
    return isAppIconVariant(pick) ? pick : DEFAULT_APP_ICON
  } catch {
    return DEFAULT_APP_ICON
  }
}

/** The 512px PNG for a colourway, staged by `build.copy` as `Resources/app/app-icons`. */
export function appIconFile(iconsDir: string, variant: AppIconVariant): string {
  return join(iconsDir, `${variant}.png`)
}

/**
 * The native side of changing the Dock icon while the app runs. Electrobun
 * 2.0.1 exposes `Utils.setDockIconVisible` but no setter for the icon image,
 * so the shell passes no port today and the applier reports `false`; the
 * choice is still persisted and the web says so. A shell build that gains a
 * setter supplies it here, and nothing else changes.
 */
export type NativeDockIcon = (imageFile: string) => void | Promise<void>

export function createAppIconApplier(options: {
  iconsDir: string
  platform: string
  native?: NativeDockIcon
}): (variant: AppIconVariant) => Promise<boolean> {
  return async (variant) => {
    if (options.platform !== 'darwin' || !options.native) return false
    try {
      await options.native(appIconFile(options.iconsDir, variant))
      return true
    } catch {
      return false
    }
  }
}
