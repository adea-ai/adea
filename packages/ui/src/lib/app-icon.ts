// The Adea app icon colourways (https://github.com/adea-ai/brand). The Dock and
// desktop icon is the user's pick, defaulting to white; the icon drawn inside
// the app is not a pick, it follows light and dark appearance.
export const appIconVariants = ['white', 'violet', 'black'] as const

export type AppIconVariant = (typeof appIconVariants)[number]

export const defaultAppIcon: AppIconVariant = 'white'

export const appIconLabels: Readonly<Record<AppIconVariant, string>> = Object.freeze({
  white: 'White',
  violet: 'Violet',
  black: 'Black',
})

export function isAppIconVariant(value: unknown): value is AppIconVariant {
  return typeof value === 'string' && (appIconVariants as readonly string[]).includes(value)
}

/** The 128px rounded icon the web build serves from `public/brand`. */
export function appIconSrc(variant: AppIconVariant): string {
  return `/brand/adea-icon-${variant}.png`
}
