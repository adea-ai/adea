/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 *
 * Adea's host appearance adapter keeps the versioned preference schema,
 * migration/recovery, system-mode resolution, native surface capability, and
 * reduced-transparency policy. @adea-ai/themes owns palette records, accents,
 * color parsing, and contrast math; this module projects those records into
 * Adea's established CSS/provider shape. See NOTICE and
 * docs/research/dev-view-donor-audit.md for source and behavior provenance.
 *
 * Every built-in palette, including the default pair, is generated from
 * the published UI projection over the shared Themes catalogue. This adapter
 * retains preference and native capability authority, not palette authority.
 */

import {
  ACCENTS,
  accentForeground,
  accentValue as canonicalAccentValue,
  getAccent,
  type AccentPreset as CanonicalAccentPreset,
} from '@adea-ai/themes'
import {
  contrastRatio as canonicalContrastRatio,
  oklchToHex as canonicalOklchToHex,
  parseColor as parseCanonicalColor,
  repairContrast,
  type Oklch,
} from '@adea-ai/themes/oklch'

import {
  applyAppearanceFontSettings,
  fontSettingsBootstrapScript,
  normalizeAppearanceEditorFontSettings,
  type AppearanceEditorFontSettings,
} from '@adea-ai/ui/lib/appearance-font-settings'

import { canonicalThemeRegistry } from './canonical-theme-adapter'

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
  /**
   * The terminal's palette: `'theme'` follows the resolved interface theme, a
   * theme id pins that theme's terminal colours regardless of appearance.
   */
  terminalThemeId: 'theme' | string
  /** `'theme'`, a built-in preset id, a theme-carried `ansi-<slot>` id, or a validated `#rrggbb` color. */
  accent: 'theme' | string
  surface: 'opaque' | 'frosted' | 'translucent'
  reduceTransparency: boolean
  /** Missing in older V2 documents; the shared font defaults recover each text role. */
  fonts?: AppearanceEditorFontSettings
}>

export type AppearanceMode = 'system' | 'light' | 'dark'
export type ResolvedAppearance = 'light' | 'dark'
export type SurfacePreference = 'opaque' | 'frosted' | 'translucent'

export const APPEARANCE_STORAGE_KEY = 'appearance'
/** The pre-#425 key. Migration reads it and never deletes it. */
export const LEGACY_THEME_STORAGE_KEY = 'theme'
/**
 * Recovery envelope for unread preference documents (Dev Runtime spec,
 * "Compatibility, migrations, and waivers": a failed migration retains the
 * original record; it never silently rewrites or deletes the input). A
 * malformed or future-version document is quarantined here — before any
 * write can touch the main key — so saving valid preferences later can never
 * destroy the user's unread data.
 */
export const APPEARANCE_RECOVERY_STORAGE_KEY = 'appearance.recovery'

export type AppearanceRecoveryEnvelope = Readonly<{
  schemaVersion: 1
  reason: 'corrupt_json' | 'unsupported_record'
  capturedAt: string
  raw: string
}>

export const DARK_QUERY = '(prefers-color-scheme: dark)'
export const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)'

export const defaultAppearancePreferences: AppearancePreferencesV2 = Object.freeze({
  version: 2,
  mode: 'system',
  lightThemeId: 'adea-light',
  darkThemeId: 'adea-dark',
  terminalThemeId: 'theme',
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

/* Hex is the host preference format; the shared Themes package owns color math. */

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

function toCanonicalColor(color: RgbColor): Oklch | undefined {
  return parseCanonicalColor(colorToHex({ ...color, a: 255 }))
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
  const foregroundColor = toCanonicalColor(opaqueFront)
  const backgroundColor = toCanonicalColor(back)
  if (!foregroundColor || !backgroundColor) return 0
  return canonicalContrastRatio(foregroundColor, backgroundColor)
}

const WHITE: RgbColor = { r: 255, g: 255, b: 255, a: 255 }
const BLACK: RgbColor = { r: 0, g: 0, b: 0, a: 255 }

/** Preserve the host hex shape while delegating contrast repair to the catalogue. */
export function ensureContrast(color: RgbColor, background: RgbColor, minimum: number): RgbColor {
  if (contrastRatio(color, background) >= minimum) return color

  const renderedColor = color.a === 255 ? color : blendOver(color, background)
  const source = toCanonicalColor(renderedColor)
  const canvas = toCanonicalColor(background)
  if (!source || !canvas) return color

  for (let margin = 0; margin <= 0.05; margin = Number((margin + 0.001).toFixed(3))) {
    const repaired = repairContrast(source, canvas, minimum + margin)
    if (!repaired.satisfied) continue
    const candidate = parseColor(canonicalOklchToHex(repaired.color))
    if (candidate && contrastRatio(candidate, background) >= minimum) return candidate
  }

  return contrastRatio(WHITE, background) >= minimum ? WHITE : BLACK
}

/* The catalogue owns preset metadata; this adapter retains Adea's hex preference shape. */
export type AccentPreset = CanonicalAccentPreset

export const accentPresets: readonly AccentPreset[] = ACCENTS

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
  return getAccent(id)
}

/** The protocol index of each accent slot in a terminal palette's ANSI order. */
const ACCENT_SLOT_PROTOCOL_INDEX: Readonly<Record<string, number>> = {
  blue: 4,
  magenta: 5,
  cyan: 6,
  green: 2,
}

/**
 * Whether an accent id names a theme-carried slot — the `ansi-<slot>` ids
 * `themeAccentPresets` offers. The slot names mirror the catalogue's
 * ACCENT_PREFERENCE ranking (its own suite pins that list); an id outside it
 * falls through to the theme accent downstream, so a stale slot can never
 * ship an unreadable color.
 */
export function isThemeAccentId(id: string): boolean {
  return /^ansi-(blue|magenta|cyan|green)$/.test(id)
}

/**
 * The variant's own value for a theme-accent id. Readability is not decided
 * here: whatever comes back passes through the same 3:1 interaction gate as a
 * preset or a custom color, which is how a stored slot survives landing on a
 * theme whose palette cannot offer it.
 */
export function themeAccentValue(selection: string, variant: ThemeVariant): string | undefined {
  if (!isThemeAccentId(selection)) return undefined
  const protocolIndex = ACCENT_SLOT_PROTOCOL_INDEX[selection.slice('ansi-'.length)]
  return variant.terminal.ansi[protocolIndex]
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
 * the variant's own accent; published presets and custom colors are normalized
 * through the shared colour engine to the host's 3:1 interaction minimum.
 */
export function deriveAccentRoles(selection: string, variant: ThemeVariant): AccentRoles {
  const background = variant.colors.background
  let primary = variant.colors.primary
  let overrides = false
  if (selection !== 'theme') {
    const preset = accentPresetById(selection)
    const themeSlot = themeAccentValue(selection, variant)
    const requested = preset
      ? parseColor(canonicalAccentValue(preset, variant.appearance))
      : themeSlot
        ? parseColor(themeSlot)
        : parseColor(selection)
    if (requested) {
      primary = colorToHex(ensureContrast(requested, parseColor(background)!, 3))
      overrides = true
    }
  }
  const primaryRgb = parseColor(primary)!
  const primaryForText = colorToHex({ ...primaryRgb, a: 255 })
  const onPrimaryColor = parseCanonicalColor(accentForeground(primaryForText))
  const onPrimary = onPrimaryColor ? canonicalOklchToHex(onPrimaryColor) : colorToHex(WHITE)
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
  destructiveAction: string
  destructiveActionForeground: string
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

/* The published catalogue owns every theme palette and visual role. */
export const builtinThemeRegistry: readonly ThemeVariant[] = canonicalThemeRegistry

/*
 * The custom theme library: themes the user imported from a file, stored in
 * localStorage and merged after the built-in registry at runtime. Import and
 * projection live in the host (the lazy appearance chunk, which owns the
 * published adapters); this module owns storage, the merged registry view,
 * and token-cache invalidation.
 */

export type CustomThemeStored = Readonly<{
  /** Stable id, namespaced so it can never collide with a catalogue id. */
  id: string
  name: string
  appearance: ResolvedAppearance
  importedAt: string
  variant: ThemeVariant
  /** The flat token map the no-flash script applies for a stored selection. */
  flatTokens: Readonly<Record<string, string>>
  /** Non-fatal adjustments made while normalizing the file, for the UI. */
  notes: readonly string[]
}>

export const CUSTOM_THEME_LIBRARY_STORAGE_KEY = 'appearance.library'
const CUSTOM_THEME_ID_PREFIX = 'custom-'

/**
 * The imported-theme set lives on the host object, not in module state: the
 * dev graph (and any consumer graph) can legitimately load this module
 * twice — theme-provider's relative import and the components subpath are
 * distinct module records — and a singleton array would fork the registry.
 * Sharing through the global keeps every instance reading one library.
 */
type LibraryHost = typeof globalThis & {
  __ADEA_THEME_LIBRARY__?: { variants: readonly ThemeVariant[] }
}
const libraryHost = globalThis as LibraryHost
const customThemeListeners = new Set<() => void>()

function customVariants(): readonly ThemeVariant[] {
  return libraryHost.__ADEA_THEME_LIBRARY__?.variants ?? []
}

/** The imported themes after the built-ins, in import order. */
export function customThemeVariants(): readonly ThemeVariant[] {
  return customVariants()
}

/** Every selectable theme: the catalogue first, then imported themes. */
export function themeRegistry(): readonly ThemeVariant[] {
  const variants = customVariants()
  return variants.length > 0 ? [...builtinThemeRegistry, ...variants] : builtinThemeRegistry
}

export function subscribeCustomThemes(listener: () => void): () => void {
  customThemeListeners.add(listener)
  return () => customThemeListeners.delete(listener)
}

function notifyCustomThemes(): void {
  for (const listener of customThemeListeners) listener()
}

function isCustomThemeId(id: string): boolean {
  return id.startsWith(CUSTOM_THEME_ID_PREFIX)
}

/**
 * Replace the imported-theme set, persist it, and invalidate derived caches.
 * A variant whose id is not custom-namespaced is namespaced here, so a
 * library file can never shadow a catalogue id.
 */
export function setCustomThemes(
  themes: readonly CustomThemeStored[],
  storage: AppearanceStorage | undefined
): void {
  const safe = themes.map((theme) =>
    isCustomThemeId(theme.id) ? theme : { ...theme, id: `${CUSTOM_THEME_ID_PREFIX}${theme.id}` }
  )
  libraryHost.__ADEA_THEME_LIBRARY__ = {
    variants: Object.freeze(safe.map((theme) => theme.variant)),
  }
  allVariantTokenNameCache = undefined
  try {
    storage?.setItem(CUSTOM_THEME_LIBRARY_STORAGE_KEY, JSON.stringify({ version: 1, themes: safe }))
  } catch {
    // Persistence is best-effort, like every other blocked-storage consumer.
  }
  notifyCustomThemes()
}

/**
 * Read the stored library. A malformed document starts an empty library and
 * quarantines the raw bytes, mirroring the appearance-preference recovery
 * contract; individual invalid records are dropped, not fatal.
 */
export function readCustomThemeLibrary(
  storage: AppearanceStorage | undefined
): readonly CustomThemeStored[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(CUSTOM_THEME_LIBRARY_STORAGE_KEY)
    if (!raw) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      retainRecoveryEnvelope(storage, raw, 'corrupt_json')
      return []
    }
    const record = parsed as { version?: unknown; themes?: unknown }
    if (record.version !== 1 || !Array.isArray(record.themes)) {
      retainRecoveryEnvelope(storage, raw, 'unsupported_record')
      return []
    }
    const themes: CustomThemeStored[] = []
    for (const entry of record.themes) {
      const theme = entry as Partial<CustomThemeStored>
      if (
        typeof theme?.id === 'string' &&
        typeof theme.name === 'string' &&
        (theme.appearance === 'light' || theme.appearance === 'dark') &&
        typeof theme.importedAt === 'string' &&
        theme.variant &&
        theme.flatTokens
      ) {
        themes.push(theme as CustomThemeStored)
      }
    }
    libraryHost.__ADEA_THEME_LIBRARY__ = {
      variants: Object.freeze(themes.map((theme) => theme.variant)),
    }
    allVariantTokenNameCache = undefined
    return themes
  } catch {
    return []
  }
}

export function removeCustomTheme(id: string, storage: AppearanceStorage | undefined): void {
  setCustomThemes(
    readCustomThemeLibrary(storage).filter((theme) => theme.id !== id),
    storage
  )
}

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
  if (accentPresetById(value) || isThemeAccentId(value)) return value
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
      terminalThemeId: normalizeThemeId(record.terminalThemeId, 'theme'),
      accent: normalizeAccent(record.accent),
      surface: normalizeSurface(record.surface),
      reduceTransparency: record.reduceTransparency === true,
      ...(record.fonts === undefined
        ? {}
        : { fonts: normalizeAppearanceEditorFontSettings(record.fonts).settings }),
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

export type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * Quarantine an unread raw document into the recovery envelope. Runs at read
 * time — before any later write can overwrite the main key — and is
 * idempotent: re-reading the same unread value refreshes the capture without
 * losing it.
 */
function retainRecoveryEnvelope(
  storage: AppearanceStorage,
  raw: string,
  reason: AppearanceRecoveryEnvelope['reason']
): void {
  try {
    const envelope: AppearanceRecoveryEnvelope = {
      schemaVersion: 1,
      reason,
      capturedAt: new Date().toISOString(),
      raw,
    }
    storage.setItem(APPEARANCE_RECOVERY_STORAGE_KEY, JSON.stringify(envelope))
  } catch {
    // Quarantine is best-effort; the active preference still fails closed.
  }
}

/**
 * Read the appearance preferences: the v2 key first, then the legacy `theme`
 * key, then defaults. A malformed or future-version document is quarantined
 * into the recovery envelope and the defaults are returned; storage failures
 * degrade to defaults like every other blocked-storage consumer.
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
        retainRecoveryEnvelope(storage, raw, 'corrupt_json')
        return defaultAppearancePreferences
      }
      const normalized = normalizeAppearancePreferences(parsed)
      if (normalized.retainedRaw !== undefined) {
        retainRecoveryEnvelope(
          storage,
          raw,
          typeof parsed === 'object' && parsed !== null ? 'unsupported_record' : 'corrupt_json'
        )
      }
      return normalized.value
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
  /**
   * The pinned terminal palette, or `undefined` when the terminal follows the
   * interface theme. Resolved here so the apply order is explicit: the
   * override is written after every variant token.
   */
  terminalOverride: ThemeTerminalPalette | undefined
  effectiveSurface: EffectiveSurface
  reduceTransparencyActive: boolean
  fonts?: AppearanceEditorFontSettings
}>

/** Resolve preferences against the environment into the applied document state. */
export function resolveAppearanceState(
  preferences: AppearancePreferencesV2,
  environment: Readonly<{
    systemAppearance: ResolvedAppearance
    osReducedTransparency: boolean
    nativeTranslucency: boolean
  }>,
  registry: readonly ThemeVariant[] = themeRegistry()
): ResolvedAppearanceState {
  const resolvedMode = resolveAppearanceMode(preferences.mode, environment.systemAppearance)
  const variant = resolveThemeVariant(registry, preferences, resolvedMode)
  return {
    resolvedMode,
    variant,
    fonts: normalizeAppearanceEditorFontSettings(preferences.fonts).settings,
    accent: deriveAccentRoles(preferences.accent, variant),
    terminalOverride: resolveTerminalOverride(preferences.terminalThemeId, registry),
    effectiveSurface: resolveSurface(preferences.surface, {
      osReducedTransparency: environment.osReducedTransparency,
      userReducedTransparency: preferences.reduceTransparency,
      nativeTranslucency: environment.nativeTranslucency,
    }),
    reduceTransparencyActive: environment.osReducedTransparency || preferences.reduceTransparency,
  }
}

/**
 * The pinned terminal palette, or `undefined` when the terminal follows the
 * interface theme. An id that no longer resolves (deleted theme, corruption
 * that slipped past normalize) also degrades to the interface palette — never
 * to a blank or half-painted terminal.
 */
function resolveTerminalOverride(
  terminalThemeId: string,
  registry: readonly ThemeVariant[]
): ThemeTerminalPalette | undefined {
  if (terminalThemeId === 'theme') return undefined
  return registry.find((variant) => variant.id === terminalThemeId)?.terminal
}

const SURFACE_BACKGROUND_ALPHA: Record<EffectiveSurface, string> = {
  opaque: '1',
  frosted: '0.92',
  translucent: '0.8',
}

/**
 * The `--terminal-*` custom properties one terminal palette owns. The variant
 * mapping (interface theme) and the pinned terminal override both spell their
 * token names through this helper: a rename on either side would silently
 * leave stale ANSI slots inline, beating the stylesheet forever.
 */
function terminalTokens(palette: ThemeTerminalPalette): Record<string, string> {
  const tokens: Record<string, string> = {
    '--terminal-background': palette.background,
    '--terminal-foreground': palette.foreground,
    '--terminal-cursor': palette.cursor,
    '--terminal-selection': palette.selection,
  }
  const ansiNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
  for (const [index, color] of palette.ansi.entries()) {
    const name = ansiNames[index % 8]!
    tokens[index < 8 ? `--terminal-ansi-${name}` : `--terminal-ansi-bright-${name}`] = color
  }
  return tokens
}

/**
 * The custom properties a non-default variant owns, as a flat map. This one
 * mapping feeds both the live provider and the pre-paint no-flash script, so
 * a restored first paint and a later live switch cannot disagree. Default
 * variants return an empty map: `styles/canonical-themes.css` declares those tokens.
 */
export function flatVariantTokens(variant: ThemeVariant): Record<string, string> {
  if (isDefaultVariant(variant)) return {}
  const tokens: Record<string, string> = {}
  for (const [role, value] of Object.entries(variant.colors)) {
    tokens[`--${kebabCase(role)}`] = value
  }
  Object.assign(tokens, terminalTokens(variant.terminal))
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
 * `styles/canonical-themes.css` declares those published tokens already.
 */
export function applyAppearanceToDocument(
  document: Document,
  state: ResolvedAppearanceState
): void {
  const root = document.documentElement
  const style = root.style
  applyAppearanceFontSettings(root, state.fonts)

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
  // the accent roles, never the surface or text palette. Returning to
  // `theme` must also *remove* a previous override's inline properties — they
  // beat the stylesheet, so leaving them behind made "Theme default" look like
  // a dead button after any preset or custom accent had been used.
  if (state.accent.overrides) {
    setToken('--primary', state.accent.primary)
    setToken('--primary-foreground', state.accent.onPrimary)
    setToken('--ring', state.accent.ring)
  } else {
    style.removeProperty('--primary')
    style.removeProperty('--primary-foreground')
    style.removeProperty('--ring')
  }
  // A variant's tokens are written as INLINE custom properties, which beat the
  // stylesheet. `flatVariantTokens` returns `{}` for a default variant, so
  // switching from a custom variant back to the default wrote nothing AND
  // removed nothing — the previous palette (surface, 16 terminal ANSI slots,
  // editor roles, chart colours) stayed inline while `dataset.theme` claimed
  // the default. The accent branch above already handles this for the three
  // accent roles; the same removal is needed here for every variant token.
  const nextTokens = flatVariantTokens(state.variant)
  for (const [name, value] of Object.entries(nextTokens)) {
    // The accent branch above owns these three roles. A non-default variant
    // also declares them, and writing the variant's copy AFTER the accent
    // override silently clobbered the accent for every catalogue theme — the
    // preset only ever took effect on the default pair, whose tokens are
    // stylesheet-owned and therefore never reach this loop.
    if (state.accent.overrides && ACCENT_OWNED_TOKENS.has(name)) continue
    setToken(name, value)
  }
  for (const name of allVariantTokenNames()) {
    // The three accent roles are owned by the branch above, which already
    // sets them when an override is active and removes them when it is not.
    // They also appear as variant colours, so removing them here would strip
    // an accent override the caller had just applied.
    if (ACCENT_OWNED_TOKENS.has(name)) continue
    if (!(name in nextTokens)) style.removeProperty(name)
  }
  // The pinned terminal palette is written LAST: it overlays whatever the
  // interface variant (or the default variant's stylesheet) contributed.
  // Dropping the pin needs no removal here — with `terminalOverride` absent
  // the variant loop rewrote the interface palette inline, or the removal
  // sweep above handed those names back to the stylesheet.
  if (state.terminalOverride) {
    for (const [name, value] of Object.entries(terminalTokens(state.terminalOverride))) {
      setToken(name, value)
    }
  }
}

/** Token names the accent branch above owns, not the variant loop. */
const ACCENT_OWNED_TOKENS: ReadonlySet<string> = new Set([
  '--primary',
  '--primary-foreground',
  '--ring',
])

/** Every custom property name any registered variant can write. */
let allVariantTokenNameCache: ReadonlySet<string> | undefined
function allVariantTokenNames(): ReadonlySet<string> {
  allVariantTokenNameCache ??= new Set(
    themeRegistry().flatMap((variant) => Object.keys(flatVariantTokens(variant)))
  )
  return allVariantTokenNameCache
}

/**
 * The no-flash preload script rendered in the document head. It re-resolves
 * the stored (or legacy) preference against the OS before first paint and
 * applies the same document state the provider would, including System font
 * defaults on a fresh install, so hydration never shows the wrong palette or
 * downloads a theme font before the user's font preference is applied.
 * Palette values are not embedded: every non-default
 * variant's tokens are declared in the generated `styles/canonical-themes.css`
 * under its `data-theme` attribute, including the default pair, so a render-blocking stylesheet plus the resolved
 * attribute paint the right palette. Accent overrides land with the provider:
 * they decorate the resolved palette and cannot produce a wrong-palette flash.
 * The pinned terminal palette lands there too — terminals only exist after
 * application JavaScript mounts, so there is no pre-hydration terminal paint.
 */
export function appearanceThemeScript(): string {
  const ids = JSON.stringify(
    builtinThemeRegistry.map((variant) => ({
      id: variant.id,
      dark: variant.appearance === 'dark',
    }))
  )
  const alpha = JSON.stringify(SURFACE_BACKGROUND_ALPHA)
  return `(function(){try{
var prefs=null;var raw=null;
try{raw=localStorage.getItem('${APPEARANCE_STORAGE_KEY}')}catch(e){}
if(raw){try{var parsed=JSON.parse(raw);if(parsed&&parsed.version===2)prefs=parsed}catch(e){}}
var mode='system';
if(prefs){if(prefs.mode==='light'||prefs.mode==='dark')mode=prefs.mode}
else{try{var t=localStorage.getItem('${LEGACY_THEME_STORAGE_KEY}');if(t==='light'||t==='dark')mode=t}catch(e){}}
var dark=mode==='dark'||(mode==='system'&&window.matchMedia('${DARK_QUERY}').matches);
var registry=${ids};
var wanted=dark?(prefs&&prefs.darkThemeId)||'${defaultAppearancePreferences.darkThemeId}':(prefs&&prefs.lightThemeId)||'${defaultAppearancePreferences.lightThemeId}';
var variant=null;var found=false;
for(var i=0;i<registry.length;i++){if(registry[i].id===wanted){variant=registry[i];found=true;break}}
if(!found){try{var lib=JSON.parse(localStorage.getItem('${CUSTOM_THEME_LIBRARY_STORAGE_KEY}')||'null');if(lib&&lib.themes){for(var k=0;k<lib.themes.length;k++){if(lib.themes[k].id===wanted){variant={id:lib.themes[k].id,tokens:lib.themes[k].flatTokens};found=true;break}}}}catch(e){}}
if(!found){for(var j=0;j<registry.length;j++){if(registry[j].dark===dark){variant=registry[j];break}}}
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
${fontSettingsBootstrapScript(APPEARANCE_STORAGE_KEY, 2)}
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
