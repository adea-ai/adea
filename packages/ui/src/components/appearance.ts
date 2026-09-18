/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 *
 * Appearance domain model substantially translated from Zeron
 * crates/theme/src/lib.rs and crates/ui/src/appearance.rs, revision
 * 30a9a9537c5ec96226c87f4bf349b6f77c5dfb59: color math with WCAG contrast,
 * accent role derivation, independent light/dark theme selection, the
 * system/light/dark mode resolver, surface preference resolution, the theme
 * registry with deterministic built-in fallback, and its validation rules.
 * Modified for TypeScript, Adea's token layer, custom accent validation,
 * the translucent surface capability, and the user reduced-transparency
 * policy Zeron lacks. See NOTICE and docs/research/dev-view-donor-audit.md.
 *
 * This module is the declared token layer for the built-in theme palette
 * data: the color string literals below are the theme itself, exactly like
 * the declarations in `styles/theme.css` (see
 * `scripts/check-theme-colors.mjs`).
 */

/**
 * The versioned client appearance preference (Dev Runtime spec,
 * "Appearance and App Library"). Stored as one JSON document; the legacy
 * single `theme` key migrates into it without deleting the old value.
 */
export type AppearancePreferencesV2 = Readonly<{
  version: 2
  mode: AppearanceMode
  lightThemeId: string
  darkThemeId: string
  /** `'theme'`, a built-in preset id, or a validated `#rrggbb` color. */
  accent: 'theme' | string
  surface: 'opaque' | 'frosted' | 'translucent'
  reduceTransparency: boolean
}>

export type AppearanceMode = 'system' | 'light' | 'dark'
export type ResolvedAppearance = 'light' | 'dark'
export type SurfacePreference = 'opaque' | 'frosted' | 'translucent'

export const APPEARANCE_STORAGE_KEY = 'appearance'
/** The pre-#425 key. Migration reads it and never deletes it. */
export const LEGACY_THEME_STORAGE_KEY = 'theme'

export const DARK_QUERY = '(prefers-color-scheme: dark)'
export const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)'

export const defaultAppearancePreferences: AppearancePreferencesV2 = Object.freeze({
  version: 2,
  mode: 'system',
  lightThemeId: 'adea-light',
  darkThemeId: 'adea-dark',
  accent: 'theme',
  surface: 'opaque',
  reduceTransparency: false,
})

/**
 * Combine the user's choice with the OS state. A pinned mode ignores the OS;
 * `system` follows it. (Zeron `resolve`.)
 */
export function resolveAppearanceMode(
  mode: AppearanceMode,
  system: ResolvedAppearance
): ResolvedAppearance {
  if (mode === 'system') return system
  return mode
}

/*
 * Color math — Zeron `Color`, translated. Values are `#rgb`, `#rgba`,
 * `#rrggbb`, or `#rrggbbaa` strings.
 */

export type RgbColor = Readonly<{ r: number; g: number; b: number; a: number }>

export class ColorParseError extends Error {
  constructor() {
    super('expected a CSS hex color (#rgb, #rgba, #rrggbb, or #rrggbbaa)')
    this.name = 'ColorParseError'
  }
}

const NIBBLES: Record<string, number> = {
  '0': 0,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  a: 10,
  b: 11,
  c: 12,
  d: 13,
  e: 14,
  f: 15,
  A: 10,
  B: 11,
  C: 12,
  D: 13,
  E: 14,
  F: 15,
}

function expandNibble(nibble: number): number {
  return (nibble << 4) | nibble
}

function parseByte(high: number, low: number): number {
  return (high << 4) | low
}

/** Parse a hex color. Returns `undefined` for anything unsupported. */
export function parseColor(value: string): RgbColor | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('#')) return undefined
  const bytes = trimmed.slice(1)
  if (bytes.length === 3 || bytes.length === 4) {
    const nibbles: number[] = []
    for (const character of bytes) {
      const nibble = NIBBLES[character]
      if (nibble === undefined) return undefined
      nibbles.push(nibble)
    }
    return {
      r: expandNibble(nibbles[0]!),
      g: expandNibble(nibbles[1]!),
      b: expandNibble(nibbles[2]!),
      a: nibbles.length === 4 ? expandNibble(nibbles[3]!) : 255,
    }
  }
  if (bytes.length === 6 || bytes.length === 8) {
    const nibbles: number[] = []
    for (const character of bytes) {
      const nibble = NIBBLES[character]
      if (nibble === undefined) return undefined
      nibbles.push(nibble)
    }
    const pair = (index: number) => parseByte(nibbles[index]!, nibbles[index + 1]!)
    return {
      r: pair(0),
      g: pair(2),
      b: pair(4),
      a: nibbles.length === 8 ? pair(6) : 255,
    }
  }
  return undefined
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, '0')
}

export function colorToHex(color: RgbColor): string {
  if (color.a === 255) return `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}`
  return `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}${toHexByte(color.a)}`
}

function blendOver(foreground: RgbColor, background: RgbColor): RgbColor {
  const alpha = foreground.a / 255
  const blend = (front: number, back: number) => Math.round(front * alpha + back * (1 - alpha))
  return {
    r: blend(foreground.r, background.r),
    g: blend(foreground.g, background.g),
    b: blend(foreground.b, background.b),
    a: 255,
  }
}

function mixColors(left: RgbColor, right: RgbColor, amount: number): RgbColor {
  const clamped = Math.min(1, Math.max(0, amount))
  const mix = (a: number, b: number) => Math.round(a + (b - a) * clamped)
  return { r: mix(left.r, right.r), g: mix(left.g, right.g), b: mix(left.b, right.b), a: 255 }
}

function linearChannel(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(color: RgbColor): number {
  return (
    0.2126 * linearChannel(color.r) +
    0.7152 * linearChannel(color.g) +
    0.0722 * linearChannel(color.b)
  )
}

/** WCAG contrast ratio between two colors. Alpha composites over the background first. */
export function contrastRatio(
  foreground: RgbColor | string,
  background: RgbColor | string
): number {
  const front = typeof foreground === 'string' ? parseColor(foreground) : foreground
  const back = typeof background === 'string' ? parseColor(background) : background
  if (!front || !back) return 0
  const opaqueFront = front.a === 255 ? front : blendOver(front, back)
  const a = relativeLuminance(opaqueFront)
  const b = relativeLuminance(back)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function bestOnColor(color: RgbColor): RgbColor {
  return contrastRatio(WHITE, color) >= contrastRatio(BLACK, color) ? WHITE : BLACK
}

const WHITE: RgbColor = { r: 255, g: 255, b: 255, a: 255 }
const BLACK: RgbColor = { r: 0, g: 0, b: 0, a: 255 }

/** Move toward black or white until the requested contrast is met. (Zeron `ensure_contrast`.) */
function ensureContrast(color: RgbColor, background: RgbColor, minimum: number): RgbColor {
  if (contrastRatio(color, background) >= minimum) return color
  const target =
    contrastRatio(BLACK, background) >= contrastRatio(WHITE, background) ? BLACK : WHITE
  for (let step = 1; step <= 20; step++) {
    const candidate = mixColors(color, target, step / 20)
    if (contrastRatio(candidate, background) >= minimum) return candidate
  }
  return target
}

/*
 * Accent — Zeron `AccentPreset`/`AccentSelection`/`AccentRoles` with Adea's
 * custom-color validation. Presets carry per-appearance values; a custom
 * color is normalized to the 3:1 interaction minimum instead of rejected
 * outright, and unparseable values fall back to the theme default.
 */

export type AccentPreset = Readonly<{
  id: string
  label: string
  dark: string
  light: string
}>

export const accentPresets: readonly AccentPreset[] = Object.freeze([
  { id: 'violet', label: 'Violet', dark: '#a78bfa', light: '#6d28d9' },
  { id: 'blue', label: 'Blue', dark: '#60a5fa', light: '#2563eb' },
  { id: 'green', label: 'Green', dark: '#4ade80', light: '#15803d' },
  { id: 'amber', label: 'Amber', dark: '#fbbf24', light: '#b45309' },
  { id: 'cyan', label: 'Cyan', dark: '#22d3ee', light: '#0e7490' },
  { id: 'pink', label: 'Pink', dark: '#f472b6', light: '#be185d' },
])

/**
 * Normalize a custom accent color against a variant background: unparseable
 * input is rejected (`undefined`), and any accepted color is raised to the
 * 3:1 interaction minimum so an accent can never ship unreadable.
 */
export function normalizeAccentValue(value: string, background: string): string | undefined {
  const parsed = parseColor(value)
  if (!parsed) return undefined
  const backdrop = parseColor(background) ?? WHITE
  return colorToHex(ensureContrast(parsed, backdrop, 3))
}

export function accentPresetById(id: string): AccentPreset | undefined {
  return accentPresets.find((preset) => preset.id === id)
}

export type AccentRoles = Readonly<{
  /** Interactive primary. */
  primary: string
  /** Text drawn on `primary`-filled controls; ≥ 4.5:1 against it. */
  onPrimary: string
  /** Hover/press emphasis derived from the primary. */
  strong: string
  /** Focus ring color. */
  ring: string
  /** False when the selection is the variant's own accent and no role should be overridden. */
  overrides: boolean
}>

/**
 * Derive the accent roles for a selection against a variant. `'theme'` keeps
 * the variant's own accent; presets and custom colors are normalized to the
 * 3:1 interaction minimum (Zeron `AccentRoles::derive`, thresholds preserved).
 */
export function deriveAccentRoles(selection: string, variant: ThemeVariant): AccentRoles {
  const background = variant.colors.background
  let primary = variant.colors.primary
  let overrides = false
  if (selection !== 'theme') {
    const preset = accentPresetById(selection)
    const requested = preset
      ? parseColor(variant.appearance === 'dark' ? preset.dark : preset.light)
      : parseColor(selection)
    if (requested) {
      primary = colorToHex(ensureContrast(requested, parseColor(background)!, 3))
      overrides = true
    }
  }
  const primaryRgb = parseColor(primary)!
  const onPrimary = colorToHex(bestOnColor(primaryRgb))
  let strong = primary
  if (contrastRatio(onPrimary, strong) < 4.5) {
    strong = colorToHex(ensureContrast(primaryRgb, parseColor(onPrimary)!, 4.5))
  }
  return { primary, onPrimary, strong, ring: strong, overrides }
}

/*
 * Surface — Zeron `SurfacePreference.resolve` extended with Adea's
 * translucent capability gate and the reduced-transparency policy: the OS
 * setting or the user preference forces an accessible opaque fallback, and a
 * translucent request on a host without native translucency renders the
 * tokenized frosted surface instead of pretending to OS vibrancy.
 */
export type EffectiveSurface = 'opaque' | 'frosted' | 'translucent'

export function resolveSurface(
  preference: SurfacePreference,
  environment: Readonly<{
    osReducedTransparency: boolean
    userReducedTransparency: boolean
    nativeTranslucency: boolean
  }>
): EffectiveSurface {
  if (environment.osReducedTransparency || environment.userReducedTransparency) return 'opaque'
  if (preference === 'translucent' && !environment.nativeTranslucency) return 'frosted'
  return preference
}

/*
 * Theme registry — Zeron `ThemeVariant`/`ThemeRegistry`, narrowed to Adea's
 * semantic roles. Every runtime component consumes the CSS custom properties
 * declared here; terminal ANSI and editor roles come from the same manifest
 * so a theme switch updates them live without remounting a terminal or
 * editor.
 */

export type ThemeTerminalPalette = Readonly<{
  background: string
  foreground: string
  cursor: string
  selection: string
  /** The 16 xterm ANSI slots, in protocol order. */
  ansi: readonly string[]
}>

export type ThemeEditorRoles = Readonly<{
  keyword: string
  string: string
  number: string
  comment: string
  function: string
  variable: string
  type: string
  tag: string
  attribute: string
  operator: string
  heading: string
  link: string
  diffAdd: string
  diffDelete: string
  diffHunk: string
  searchMatch: string
}>

export type ThemeChartRoles = Readonly<{
  chart1: string
  chart2: string
  chart3: string
  chart4: string
  chart5: string
  chart6: string
}>

export type ThemeColors = Readonly<{
  background: string
  foreground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  destructive: string
  success: string
  border: string
  input: string
  ring: string
}>

export type ThemeVariant = Readonly<{
  id: string
  familyId: string
  familyName: string
  name: string
  appearance: ResolvedAppearance
  colors: ThemeColors
  terminal: ThemeTerminalPalette
  editor: ThemeEditorRoles
  charts: ThemeChartRoles
}>

/**
 * The independent per-appearance theme selection (Zeron `ThemeSelection`,
 * carrying the V2 preference's field names).
 */
export type ThemeSelection = Readonly<{ lightThemeId: string; darkThemeId: string }>

export function themeSelectionVariantId(
  selection: ThemeSelection,
  appearance: ResolvedAppearance
): string {
  return appearance === 'dark' ? selection.darkThemeId : selection.lightThemeId
}

export type ValidationIssue = Readonly<{
  variantId: string
  severity: 'error' | 'warning'
  message: string
}>

/**
 * Registry validation, ported from Zeron `ThemeRegistry::validate`: core text
 * and muted text must reach 4.5:1, the accent 3:1, on-accent 4.5:1, the
 * terminal foreground 4.5:1, and every chromatic ANSI slot 3:1 (slots 0 and 8
 * are structural black/dim colors). Provenance completeness is a Zeron
 * library concept; M12 ships only built-ins, so the structural check here is
 * id/non-empty-color integrity.
 */
export function validateThemeRegistry(registry: readonly ThemeVariant[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  for (const variant of registry) {
    if (variant.id.trim().length === 0 || seen.has(variant.id)) {
      issues.push({
        variantId: variant.id,
        severity: 'error',
        message: 'variant id must be unique',
      })
    }
    seen.add(variant.id)
    const check = (role: string, foreground: string, background: string, minimum: number) => {
      const actual = contrastRatio(foreground, background)
      if (actual < minimum) {
        issues.push({
          variantId: variant.id,
          severity: 'error',
          message: `${role} contrast is ${actual.toFixed(2)}:1; expected ${minimum.toFixed(1)}:1`,
        })
      }
    }
    check('text', variant.colors.foreground, variant.colors.background, 4.5)
    check('muted text', variant.colors.mutedForeground, variant.colors.background, 4.5)
    check('primary', variant.colors.primary, variant.colors.background, 3)
    check('on-primary', variant.colors.primaryForeground, variant.colors.primary, 4.5)
    check('terminal foreground', variant.terminal.foreground, variant.terminal.background, 4.5)
    for (const [index, color] of variant.terminal.ansi.entries()) {
      if (index % 8 === 0) continue
      const actual = contrastRatio(color, variant.terminal.background)
      if (actual < 3) {
        issues.push({
          variantId: variant.id,
          severity: 'warning',
          message: `terminal ANSI slot ${index} is below 3:1`,
        })
      }
    }
    check('editor comment', variant.editor.comment, variant.colors.background, 4.5)
    check('diff delete', variant.editor.diffDelete, variant.colors.background, 3)
    check('diff add', variant.editor.diffAdd, variant.colors.background, 3)
  }
  return issues
}

/**
 * Resolve the variant for a selection, falling back deterministically to the
 * default variant of the same appearance when the stored id is missing or
 * broken — a corrupt preference degrades the palette, never the UI.
 * (Zeron `ThemeRegistry::resolve`.)
 */
export function resolveThemeVariant(
  registry: readonly ThemeVariant[],
  selection: ThemeSelection,
  appearance: ResolvedAppearance
): ThemeVariant {
  const wanted = themeSelectionVariantId(selection, appearance)
  const found = registry.find((variant) => variant.id === wanted)
  if (found) return found
  const fallbackId =
    appearance === 'dark'
      ? defaultAppearancePreferences.darkThemeId
      : defaultAppearancePreferences.lightThemeId
  const fallback = registry.find((variant) => variant.id === fallbackId)
  if (fallback) return fallback
  const sameAppearance = registry.find((variant) => variant.appearance === appearance)
  if (sameAppearance) return sameAppearance
  return registry[0]!
}

/*
 * Built-in registry — Adea's curated M12 set. `adea-light`/`adea-dark` mirror
 * the token declarations in `styles/theme.css` (which stay authoritative for
 * the defaults so first paint never shifts); `slate` is a cool quiet pair and
 * `contrast` an AA-emphasized pair. Terminal/editor/charts ship one curated
 * template per appearance so every variant keeps ANSI/syntax/diff legibility.
 */

const lightTerminal: ThemeTerminalPalette = Object.freeze({
  background: '#ffffff',
  foreground: '#1b1f24',
  cursor: '#24292f',
  selection: '#b6c7ff',
  ansi: Object.freeze([
    '#1b1f24',
    '#b91c1c',
    '#116a2e',
    '#8a5a1b',
    '#0b57d0',
    '#a0186f',
    '#0e7490',
    '#57606a',
    '#57606a',
    '#c94d4d',
    '#1f9d4f',
    '#a9752c',
    '#3b82f6',
    '#c04a92',
    '#0891b2',
    '#24292f',
  ]),
})

const darkTerminal: ThemeTerminalPalette = Object.freeze({
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selection: '#264f78',
  ansi: Object.freeze([
    '#2f3742',
    '#ff8183',
    '#56d364',
    '#e3b341',
    '#6ca4f8',
    '#db61a2',
    '#39c5cf',
    '#d5dde5',
    '#57606a',
    '#ff9494',
    '#79dd8a',
    '#f0c264',
    '#8db9ff',
    '#e87cb4',
    '#66d3dc',
    '#eef2f6',
  ]),
})

const lightEditor: ThemeEditorRoles = Object.freeze({
  keyword: '#0b57d0',
  string: '#116a2e',
  number: '#8a5a1b',
  comment: '#57606a',
  function: '#a0186f',
  variable: '#1b1f24',
  type: '#0e7490',
  tag: '#b91c1c',
  attribute: '#8a5a1b',
  operator: '#1b1f24',
  heading: '#1b1f24',
  link: '#0b57d0',
  diffAdd: '#116a2e',
  diffDelete: '#b91c1c',
  diffHunk: '#57606a',
  searchMatch: '#8a5a1b',
})

const darkEditor: ThemeEditorRoles = Object.freeze({
  keyword: '#6ca4f8',
  string: '#56d364',
  number: '#e3b341',
  comment: '#8b949e',
  function: '#db61a2',
  variable: '#e6edf3',
  type: '#39c5cf',
  tag: '#ff8183',
  attribute: '#e3b341',
  operator: '#e6edf3',
  heading: '#e6edf3',
  link: '#6ca4f8',
  diffAdd: '#56d364',
  diffDelete: '#ff8183',
  diffHunk: '#8b949e',
  searchMatch: '#e3b341',
})

const lightCharts: ThemeChartRoles = Object.freeze({
  chart1: '#0b57d0',
  chart2: '#116a2e',
  chart3: '#8a5a1b',
  chart4: '#a0186f',
  chart5: '#0e7490',
  chart6: '#57606a',
})

const darkCharts: ThemeChartRoles = Object.freeze({
  chart1: '#6ca4f8',
  chart2: '#56d364',
  chart3: '#e3b341',
  chart4: '#db61a2',
  chart5: '#39c5cf',
  chart6: '#8b949e',
})

function defineVariant(
  id: string,
  familyId: string,
  familyName: string,
  name: string,
  appearance: ResolvedAppearance,
  colors: ThemeColors
): ThemeVariant {
  const light = appearance === 'light'
  return {
    id,
    familyId,
    familyName,
    name,
    appearance,
    colors,
    terminal: light ? lightTerminal : darkTerminal,
    editor: light ? lightEditor : darkEditor,
    charts: light ? lightCharts : darkCharts,
  }
}

/** The `adea-light`/`adea-dark` entries mirror `styles/theme.css`. */
export const builtinThemeRegistry: readonly ThemeVariant[] = Object.freeze([
  defineVariant('adea-light', 'adea', 'Adea', 'Adea Light', 'light', {
    background: '#ffffff',
    foreground: '#252525',
    card: '#ffffff',
    cardForeground: '#252525',
    popover: '#ffffff',
    popoverForeground: '#252525',
    primary: '#343434',
    primaryForeground: '#fcfcfc',
    secondary: '#f7f7f7',
    secondaryForeground: '#343434',
    muted: '#f7f7f7',
    mutedForeground: '#6f6f6f',
    accent: '#f7f7f7',
    accentForeground: '#343434',
    destructive: '#c53c2b',
    success: '#1a7f37',
    border: '#ebebeb',
    input: '#ebebeb',
    ring: '#a3a3a3',
  }),
  defineVariant('adea-dark', 'adea', 'Adea', 'Adea Dark', 'dark', {
    background: '#252525',
    foreground: '#fcfcfc',
    card: '#343434',
    cardForeground: '#fcfcfc',
    popover: '#343434',
    popoverForeground: '#fcfcfc',
    primary: '#ebebeb',
    primaryForeground: '#343434',
    secondary: '#444444',
    secondaryForeground: '#fcfcfc',
    muted: '#444444',
    mutedForeground: '#a3a3a3',
    accent: '#444444',
    accentForeground: '#fcfcfc',
    destructive: '#e07060',
    success: '#3fb950',
    border: 'rgba(255, 255, 255, 0.16)',
    input: 'rgba(255, 255, 255, 0.2)',
    ring: '#7c7c7c',
  }),
  defineVariant('slate-light', 'slate', 'Slate', 'Slate Light', 'light', {
    background: '#f8fafc',
    foreground: '#0f172a',
    card: '#ffffff',
    cardForeground: '#0f172a',
    popover: '#ffffff',
    popoverForeground: '#0f172a',
    primary: '#0f172a',
    primaryForeground: '#f8fafc',
    secondary: '#e2e8f0',
    secondaryForeground: '#0f172a',
    muted: '#e2e8f0',
    mutedForeground: '#475569',
    accent: '#e2e8f0',
    accentForeground: '#0f172a',
    destructive: '#b91c1c',
    success: '#15803d',
    border: '#cbd5e1',
    input: '#cbd5e1',
    ring: '#64748b',
  }),
  defineVariant('slate-dark', 'slate', 'Slate', 'Slate Dark', 'dark', {
    background: '#0f172a',
    foreground: '#f1f5f9',
    card: '#1e293b',
    cardForeground: '#f1f5f9',
    popover: '#1e293b',
    popoverForeground: '#f1f5f9',
    primary: '#e2e8f0',
    primaryForeground: '#0f172a',
    secondary: '#334155',
    secondaryForeground: '#f1f5f9',
    muted: '#334155',
    mutedForeground: '#94a3b8',
    accent: '#334155',
    accentForeground: '#f1f5f9',
    destructive: '#f87171',
    success: '#4ade80',
    border: 'rgba(148, 163, 184, 0.2)',
    input: 'rgba(148, 163, 184, 0.25)',
    ring: '#64748b',
  }),
  defineVariant('contrast-light', 'contrast', 'High Contrast', 'High Contrast Light', 'light', {
    background: '#ffffff',
    foreground: '#000000',
    card: '#ffffff',
    cardForeground: '#000000',
    popover: '#ffffff',
    popoverForeground: '#000000',
    primary: '#143d8f',
    primaryForeground: '#ffffff',
    secondary: '#f0f0f0',
    secondaryForeground: '#000000',
    muted: '#f0f0f0',
    mutedForeground: '#333333',
    accent: '#f0f0f0',
    accentForeground: '#000000',
    destructive: '#b91c1c',
    success: '#14532d',
    border: '#767676',
    input: '#767676',
    ring: '#000000',
  }),
  defineVariant('contrast-dark', 'contrast', 'High Contrast', 'High Contrast Dark', 'dark', {
    background: '#000000',
    foreground: '#ffffff',
    card: '#0a0a0a',
    cardForeground: '#ffffff',
    popover: '#0a0a0a',
    popoverForeground: '#ffffff',
    primary: '#8ab4ff',
    primaryForeground: '#000000',
    secondary: '#1a1a1a',
    secondaryForeground: '#ffffff',
    muted: '#1a1a1a',
    mutedForeground: '#e5e5e5',
    accent: '#1a1a1a',
    accentForeground: '#ffffff',
    destructive: '#ff6b6b',
    success: '#4ade80',
    border: '#8f8f8f',
    input: '#8f8f8f',
    ring: '#ffffff',
  }),
])

/*
 * Preference storage: normalization, legacy migration, corrupt retention.
 */

function normalizeMode(value: unknown): AppearanceMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function normalizeSurface(value: unknown): SurfacePreference {
  return value === 'frosted' || value === 'translucent' || value === 'opaque' ? value : 'opaque'
}

function normalizeThemeId(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

function normalizeAccent(value: unknown): string {
  if (value === 'theme') return 'theme'
  if (typeof value !== 'string') return 'theme'
  if (accentPresetById(value)) return value
  const parsed = parseColor(value)
  return parsed ? colorToHex(parsed) : 'theme'
}

export type NormalizedPreferences = Readonly<{
  /** The strict v2 document, with every unknown field corrected to defaults. */
  value: AppearancePreferencesV2
  /**
   * The raw stored document when it was not a valid v2 record. Retained so a
   * future version (or a repaired write) never loses the user's data.
   */
  retainedRaw?: unknown
}>

/**
 * Parse a stored appearance document. Anything that is not a strict version-2
 * record falls back to the defaults and keeps the raw value for retention;
 * individual unknown values inside a v2 record are corrected field by field.
 */
export function normalizeAppearancePreferences(raw: unknown): NormalizedPreferences {
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 2) {
    return { value: defaultAppearancePreferences, retainedRaw: raw }
  }
  const record = raw as Record<string, unknown>
  return {
    value: {
      version: 2,
      mode: normalizeMode(record.mode),
      lightThemeId: normalizeThemeId(
        record.lightThemeId,
        defaultAppearancePreferences.lightThemeId
      ),
      darkThemeId: normalizeThemeId(record.darkThemeId, defaultAppearancePreferences.darkThemeId),
      accent: normalizeAccent(record.accent),
      surface: normalizeSurface(record.surface),
      reduceTransparency: record.reduceTransparency === true,
    },
  }
}

/** The legacy single-key preference, mapped into v2 during migration. */
export function migrateLegacyThemeValue(
  stored: string | null
): AppearancePreferencesV2 | undefined {
  if (stored !== 'light' && stored !== 'dark' && stored !== 'system') return undefined
  return { ...defaultAppearancePreferences, mode: stored }
}

type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * Read the appearance preferences: the v2 key first, then the legacy `theme`
 * key, then defaults. Storage failures degrade to defaults like every other
 * blocked-storage consumer.
 */
export function readAppearancePreferences(
  storage: AppearanceStorage | undefined
): AppearancePreferencesV2 {
  if (!storage) return defaultAppearancePreferences
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY)
    if (raw !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return defaultAppearancePreferences
      }
      return normalizeAppearancePreferences(parsed).value
    }
    return (
      migrateLegacyThemeValue(storage.getItem(LEGACY_THEME_STORAGE_KEY)) ??
      defaultAppearancePreferences
    )
  } catch {
    return defaultAppearancePreferences
  }
}

export function writeAppearancePreferences(
  storage: AppearanceStorage | undefined,
  preferences: AppearancePreferencesV2
): void {
  if (!storage) return
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Persistence is best-effort: private modes and full quotas keep the
    // in-memory preference.
  }
}

/*
 * Document application. Both the provider and the no-flash inline script
 * resolve preferences to the same document shape, so a pre-paint restore and
 * a live change cannot disagree.
 */

export type ResolvedAppearanceState = Readonly<{
  resolvedMode: ResolvedAppearance
  variant: ThemeVariant
  accent: AccentRoles
  effectiveSurface: EffectiveSurface
  reduceTransparencyActive: boolean
}>

/** Resolve preferences against the environment into the applied document state. */
export function resolveAppearanceState(
  preferences: AppearancePreferencesV2,
  environment: Readonly<{
    systemAppearance: ResolvedAppearance
    osReducedTransparency: boolean
    nativeTranslucency: boolean
  }>,
  registry: readonly ThemeVariant[] = builtinThemeRegistry
): ResolvedAppearanceState {
  const resolvedMode = resolveAppearanceMode(preferences.mode, environment.systemAppearance)
  const variant = resolveThemeVariant(registry, preferences, resolvedMode)
  return {
    resolvedMode,
    variant,
    accent: deriveAccentRoles(preferences.accent, variant),
    effectiveSurface: resolveSurface(preferences.surface, {
      osReducedTransparency: environment.osReducedTransparency,
      userReducedTransparency: preferences.reduceTransparency,
      nativeTranslucency: environment.nativeTranslucency,
    }),
    reduceTransparencyActive: environment.osReducedTransparency || preferences.reduceTransparency,
  }
}

const SURFACE_BACKGROUND_ALPHA: Record<EffectiveSurface, string> = {
  opaque: '1',
  frosted: '0.92',
  translucent: '0.8',
}

/**
 * The custom properties a non-default variant owns, as a flat map. This one
 * mapping feeds both the live provider and the pre-paint no-flash script, so
 * a restored first paint and a later live switch cannot disagree. Default
 * variants return an empty map: `styles/theme.css` declares those tokens.
 */
export function flatVariantTokens(variant: ThemeVariant): Record<string, string> {
  if (isDefaultVariant(variant)) return {}
  const tokens: Record<string, string> = {}
  for (const [role, value] of Object.entries(variant.colors)) {
    tokens[`--${kebabCase(role)}`] = value
  }
  const terminal = variant.terminal
  tokens['--terminal-background'] = terminal.background
  tokens['--terminal-foreground'] = terminal.foreground
  tokens['--terminal-cursor'] = terminal.cursor
  tokens['--terminal-selection'] = terminal.selection
  const ansiNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
  for (const [index, color] of terminal.ansi.entries()) {
    const name = ansiNames[index % 8]!
    tokens[index < 8 ? `--terminal-ansi-${name}` : `--terminal-ansi-bright-${name}`] = color
  }
  for (const [role, value] of Object.entries(variant.editor)) {
    tokens[`--editor-${kebabCase(role)}`] = value
  }
  for (const [index, value] of Object.values(variant.charts).entries()) {
    tokens[`--chart-${index + 1}`] = value
  }
  return tokens
}

/**
 * Apply a resolved state to a document: the `dark` class and color scheme for
 * the palette, the diagnostic data attributes, the accent role overrides, and
 * the resolved variant's semantic tokens (including terminal ANSI and editor
 * roles). CSS custom properties cascade, so terminals and editors update live
 * without remounting.
 *
 * The default `adea-light`/`adea-dark` variants skip the palette override —
 * `styles/theme.css` declares those tokens already, and leaving them CSS-owned
 * keeps first paint byte-identical to the pre-#425 app.
 */
export function applyAppearanceToDocument(
  document: Document,
  state: ResolvedAppearanceState
): void {
  const root = document.documentElement
  const style = root.style

  root.classList.toggle('dark', state.resolvedMode === 'dark')
  style.colorScheme = state.resolvedMode
  root.dataset.theme = state.variant.id
  root.dataset.appearanceMode = state.resolvedMode
  root.dataset.surface = state.effectiveSurface
  root.dataset.accent = state.accent.overrides ? 'custom' : 'theme'
  root.dataset.reduceTransparency = state.reduceTransparencyActive ? 'true' : 'false'

  const setToken = (name: string, value: string) => style.setProperty(name, value)
  setToken('--surface-alpha', SURFACE_BACKGROUND_ALPHA[state.effectiveSurface])
  // `theme` keeps every interactive role CSS-owned; an override touches only
  // the accent roles, never the surface or text palette.
  if (state.accent.overrides) {
    setToken('--primary', state.accent.primary)
    setToken('--primary-foreground', state.accent.onPrimary)
    setToken('--ring', state.accent.ring)
  }
  for (const [name, value] of Object.entries(flatVariantTokens(state.variant))) {
    setToken(name, value)
  }
}

/**
 * The no-flash preload script rendered in the document head. It re-resolves
 * the stored (or legacy) preference against the OS before first paint and
 * applies the same palette state the provider would, so hydration never shows
 * the wrong palette. Accent overrides land with the provider: they decorate
 * the resolved palette and cannot produce a wrong-palette flash.
 */
export function appearanceThemeScript(): string {
  const preload = builtinThemeRegistry.map((variant) => ({
    id: variant.id,
    dark: variant.appearance === 'dark',
    tokens: flatVariantTokens(variant),
  }))
  const registry = JSON.stringify(preload)
  const alpha = JSON.stringify(SURFACE_BACKGROUND_ALPHA)
  return `(function(){try{
var prefs=null;var raw=null;
try{raw=localStorage.getItem('${APPEARANCE_STORAGE_KEY}')}catch(e){}
if(raw){try{var parsed=JSON.parse(raw);if(parsed&&parsed.version===2)prefs=parsed}catch(e){}}
var mode='system';
if(prefs){if(prefs.mode==='light'||prefs.mode==='dark')mode=prefs.mode}
else{try{var t=localStorage.getItem('${LEGACY_THEME_STORAGE_KEY}');if(t==='light'||t==='dark')mode=t}catch(e){}}
var dark=mode==='dark'||(mode==='system'&&window.matchMedia('${DARK_QUERY}').matches);
var registry=${registry};
var wanted=dark?(prefs&&prefs.darkThemeId)||'${defaultAppearancePreferences.darkThemeId}':(prefs&&prefs.lightThemeId)||'${defaultAppearancePreferences.lightThemeId}';
var variant=null;
for(var i=0;i<registry.length;i++){if(registry[i].id===wanted)variant=registry[i]}
if(!variant){for(var j=0;j<registry.length;j++){if(registry[j].dark===dark)variant=registry[j]}}
if(!variant)variant=registry[0];
var reduce=window.matchMedia('${REDUCED_TRANSPARENCY_QUERY}').matches||!!(prefs&&prefs.reduceTransparency);
/* Pre-hydration the host translucency capability is unknown, so the script
   resolves every glass request to the conservative frosted tokens; the
   provider re-resolves with the real capability once mounted. */
var surface=reduce?'opaque':(prefs&&prefs.surface==='frosted'||prefs&&prefs.surface==='translucent'?'frosted':'opaque');
if(surface!=='opaque'&&surface!=='frosted')surface='opaque';
var r=document.documentElement,s=r.style;
r.classList.toggle('dark',dark);
s.colorScheme=dark?'dark':'light';
r.dataset.theme=variant.id;
r.dataset.appearanceMode=mode;
r.dataset.surface=surface;
r.dataset.reduceTransparency=reduce?'true':'false';
s.setProperty('--surface-alpha',${alpha}[surface]||'1');
var tokens=variant.tokens||{};
for(var name in tokens){s.setProperty(name,tokens[name])}
}catch(e){}})();`
}

function isDefaultVariant(variant: ThemeVariant): boolean {
  return (
    variant.id === defaultAppearancePreferences.lightThemeId ||
    variant.id === defaultAppearancePreferences.darkThemeId
  )
}

function kebabCase(value: string): string {
  return value.replaceAll(/[A-Z]/g, (character) => `-${character.toLocaleLowerCase()}`)
}
