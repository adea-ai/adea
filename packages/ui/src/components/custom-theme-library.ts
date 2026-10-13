/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 *
 * The custom theme library keeps the registry-validation rules of Adea's accepted
 * port of Zeron's theme registry (https://github.com/zeronsh/zeron). The library is
 * Adea's own product schema (declared-license imports, a stored `variant` per
 * theme); the shared ThemeProvider receives it as extra variants. See NOTICE and
 * docs/research/dev-view-donor-audit.md for source and behavior provenance.
 */
import type { AdeaTheme, AdeaThemeRecord } from '@adea-ai/themes'

import { contrastRatio } from '@adea-ai/ui/lib/accent-roles'
import { quarantineRecord, readVersionedRecord } from '@adea-ai/ui/lib/preference-store'
import {
  builtinThemes,
  themeRecordById,
  variantFromRecord,
  type ThemeVariant as UiThemeVariant,
} from '@adea-ai/ui/lib/themes'

/**
 * The custom theme library: themes the user imported from a file, stored in
 * `localStorage` and handed to the provider as extra variants. Import and
 * projection live in dev-view (the lazy appearance chunk); this module owns the
 * stored shape, the in-memory view, validation and the translation to the shared
 * variant shape.
 *
 * The stored shape is a compatibility surface. Imported themes written by any
 * earlier build keep resolving: `variant` stays in the host shape below and
 * `flatTokens` stays the verbatim token map, so what a user imported is what is
 * painted.
 */

export type StoredThemeAppearance = 'light' | 'dark'

export type StoredThemeTerminal = Readonly<{
  background: string
  foreground: string
  cursor: string
  selection: string
  /** The 16 xterm ANSI slots, in protocol order. */
  ansi: readonly string[]
}>

export type StoredThemeEditorRoles = Readonly<{
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

export type StoredThemeChartRoles = Readonly<{
  chart1: string
  chart2: string
  chart3: string
  chart4: string
  chart5: string
  chart6: string
}>

export type StoredThemeColors = Readonly<{
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

/** The variant shape the library has always stored for an imported theme. */
export type StoredThemeVariant = Readonly<{
  id: string
  familyId: string
  familyName: string
  name: string
  appearance: StoredThemeAppearance
  colors: StoredThemeColors
  terminal: StoredThemeTerminal
  editor: StoredThemeEditorRoles
  charts: StoredThemeChartRoles
}>

export type CustomThemeStored = Readonly<{
  /** Stable id, namespaced so it can never collide with a catalogue id. */
  id: string
  name: string
  appearance: StoredThemeAppearance
  importedAt: string
  variant: StoredThemeVariant
  /** The flat token map the no-flash script applies for a stored selection. */
  flatTokens: Readonly<Record<string, string>>
  /** Non-fatal adjustments made while normalizing the file, for the UI. */
  notes: readonly string[]
}>

export type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>

export const CUSTOM_THEME_LIBRARY_STORAGE_KEY = 'appearance.library'
/**
 * Where an unreadable library is quarantined. It is its own key: the library and
 * the appearance preference used to share `appearance.recovery`, so one could
 * overwrite the other's capture.
 */
export const CUSTOM_THEME_LIBRARY_RECOVERY_KEY = 'appearance.library.recovery'
const CUSTOM_THEME_LIBRARY_VERSION = 1
const CUSTOM_THEME_ID_PREFIX = 'custom-'

/*
 * Registry validation, ported from Zeron `ThemeRegistry::validate`: core text and
 * muted text must reach 4.5:1, the accent 3:1, on-accent 4.5:1, the terminal
 * foreground 4.5:1, and every chromatic ANSI slot 3:1 (slots 0 and 8 are
 * structural black/dim colors). Import runs it over the one variant it just built.
 */

export type ValidationIssue = Readonly<{
  variantId: string
  severity: 'error' | 'warning'
  message: string
}>

export function validateThemeRegistry(registry: readonly StoredThemeVariant[]): ValidationIssue[] {
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

/*
 * The flat token map: the custom properties an imported theme owns. It is stored
 * with the theme (`flatTokens`) so the pre-paint script can apply it without the
 * library's code, and the provider writes it verbatim over everything it derives.
 */

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

function kebabCase(value: string): string {
  return value.replaceAll(/[A-Z]/g, (character) => `-${character.toLocaleLowerCase()}`)
}

function terminalTokens(palette: StoredThemeTerminal): Record<string, string> {
  const tokens: Record<string, string> = {
    '--terminal-background': palette.background,
    '--terminal-foreground': palette.foreground,
    '--terminal-cursor': palette.cursor,
    '--terminal-selection': palette.selection,
  }
  for (const [index, color] of palette.ansi.entries()) {
    const name = ANSI_NAMES[index % 8]!
    tokens[index < 8 ? `--terminal-ansi-${name}` : `--terminal-ansi-bright-${name}`] = color
  }
  return tokens
}

/** The custom properties an imported variant owns, as a flat map. */
export function flatVariantTokens(variant: StoredThemeVariant): Record<string, string> {
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

/*
 * The shared variant for a stored theme.
 *
 * The stored variant is lossy against the catalogue's record shape (it has no
 * warning, info or hover roles), so the record is reconstructed from it, the same
 * reconstruction the appearance editor previews. The shared provider derives what
 * the import never stored (status hues, sidebar, hover) from that record, and then
 * writes `flatTokens` verbatim over the derivation: every stored key paints exactly
 * what the user imported.
 */

const IMPORTED_PROVENANCE = {
  project: 'Adea themes catalogue',
  url: 'https://github.com/adea-ai/themes',
  license: 'Apache-2.0',
} as const

function ansiRamp(variant: StoredThemeVariant): AdeaTheme['ansi'] {
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = variant.terminal.ansi
  return {
    black: black!,
    red: red!,
    green: green!,
    yellow: yellow!,
    blue: blue!,
    magenta: magenta!,
    cyan: cyan!,
    white: white!,
    brightBlack: brightBlack!,
    brightRed: brightRed!,
    brightGreen: brightGreen!,
    brightYellow: brightYellow!,
    brightBlue: brightBlue!,
    brightMagenta: brightMagenta!,
    brightCyan: brightCyan!,
    brightWhite: brightWhite!,
  }
}

/**
 * The catalogue-shaped record for an imported variant. The editor reads only its
 * surface, text, border and accent roles; warning and info are the ANSI yellow and
 * blue because the stored variant has no such roles.
 */
export function storedVariantRecord(variant: StoredThemeVariant): AdeaThemeRecord {
  const colors = variant.colors
  const ansi = ansiRamp(variant)
  const theme: AdeaTheme = {
    id: variant.id,
    name: variant.name,
    appearance: variant.appearance,
    colors: {
      background: colors.background,
      foreground: colors.foreground,
      surface: colors.card,
      surfaceElevated: colors.popover,
      surfaceHover: colors.accent,
      surfaceActive: colors.border,
      border: colors.border,
      borderMuted: colors.border,
      text: colors.foreground,
      textMuted: colors.mutedForeground,
      textSubtle: colors.mutedForeground,
      accent: colors.primary,
      accentForeground: colors.primaryForeground,
      success: colors.success,
      warning: ansi.yellow,
      error: colors.destructive,
      info: ansi.blue,
    },
    ansi,
    cursor: variant.terminal.cursor,
    selection: variant.terminal.selection,
  }
  return {
    ...theme,
    family: variant.familyId,
    familyLabel: variant.familyName,
    label: variant.name,
    description: `${variant.name}, imported into your library.`,
    provenance: IMPORTED_PROVENANCE,
    tags: ['imported', variant.appearance],
  }
}

/**
 * The shared-provider variant for a stored theme: derived roles from the
 * reconstructed record, then `flatTokens` verbatim.
 *
 * A record the shared projection cannot map falls back to the default theme of the
 * same appearance under the stored identity, so an import that the projection
 * rejects still paints from its tokens instead of vanishing.
 */
export function toUiVariant(stored: CustomThemeStored): UiThemeVariant {
  const { variant } = stored
  let base: UiThemeVariant
  try {
    base = variantFromRecord(storedVariantRecord(variant))
  } catch {
    const fallback = themeRecordById(variant.appearance === 'dark' ? 'adea-dark' : 'adea-light')!
    base = {
      ...variantFromRecord(fallback),
      id: variant.id,
      family: variant.familyId,
      familyLabel: variant.familyName,
      label: variant.name,
      description: `${variant.name}, imported into your library.`,
      provenance: {
        source: IMPORTED_PROVENANCE.project,
        url: IMPORTED_PROVENANCE.url,
        license: IMPORTED_PROVENANCE.license,
      },
    }
  }
  return { ...base, tokens: stored.flatTokens }
}

/*
 * The in-memory library.
 *
 * It lives on the host object, not in module state: the dev graph (and any consumer
 * graph) can legitimately load this module twice (a relative import and the
 * components subpath are distinct module records), and a singleton array would fork
 * the registry. The listeners live there too, so a change made through one instance
 * reaches a subscriber registered through the other.
 */
type LibraryState = {
  themes: readonly CustomThemeStored[]
  /** Derived from `themes`; rebuilt on first read after each change. */
  uiVariants?: readonly UiThemeVariant[]
  listeners: Set<() => void>
}
type LibraryHost = typeof globalThis & { __ADEA_THEME_LIBRARY__?: Partial<LibraryState> }
const libraryHost = globalThis as LibraryHost

function library(): LibraryState {
  const existing = libraryHost.__ADEA_THEME_LIBRARY__
  if (existing && Array.isArray(existing.themes) && existing.listeners) {
    return existing as LibraryState
  }
  // A host object written by an older module instance has another shape.
  const created: LibraryState = { themes: [], listeners: existing?.listeners ?? new Set() }
  libraryHost.__ADEA_THEME_LIBRARY__ = created
  return created
}

function replaceThemes(themes: readonly CustomThemeStored[]): void {
  const state = library()
  state.themes = Object.freeze([...themes])
  state.uiVariants = undefined
}

/** The imported themes' stored variants, in import order. */
export function customThemeVariants(): readonly StoredThemeVariant[] {
  return library().themes.map((theme) => theme.variant)
}

/** The imported themes as shared-provider variants: what the provider's `themes` takes. */
export function customUiVariants(): readonly UiThemeVariant[] {
  const state = library()
  state.uiVariants ??= Object.freeze(state.themes.map(toUiVariant))
  return state.uiVariants
}

/** Every selectable theme: the catalogue first, then imported themes. */
export function themeRegistry(): readonly UiThemeVariant[] {
  const custom = customUiVariants()
  return custom.length > 0 ? [...builtinThemes, ...custom] : builtinThemes
}

export function subscribeCustomThemes(listener: () => void): () => void {
  const { listeners } = library()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyCustomThemes(): void {
  for (const listener of library().listeners) listener()
}

function isCustomThemeId(id: string): boolean {
  return id.startsWith(CUSTOM_THEME_ID_PREFIX)
}

/**
 * Replace the imported-theme set, persist it, and tell subscribers. A theme whose id
 * is not custom-namespaced is namespaced here, so a library file can never shadow a
 * catalogue id.
 */
export function setCustomThemes(
  themes: readonly CustomThemeStored[],
  storage: AppearanceStorage | undefined
): void {
  const safe = themes.map((theme) => {
    if (isCustomThemeId(theme.id)) return theme
    const id = `${CUSTOM_THEME_ID_PREFIX}${theme.id}`
    return { ...theme, id, variant: { ...theme.variant, id } }
  })
  replaceThemes(safe)
  try {
    storage?.setItem(
      CUSTOM_THEME_LIBRARY_STORAGE_KEY,
      JSON.stringify({ version: CUSTOM_THEME_LIBRARY_VERSION, themes: safe })
    )
  } catch {
    // Persistence is best-effort, like every other blocked-storage consumer.
  }
  notifyCustomThemes()
}

function isStoredTheme(entry: unknown): entry is CustomThemeStored {
  const theme = entry as Partial<CustomThemeStored> | null
  return (
    typeof theme?.id === 'string' &&
    typeof theme.name === 'string' &&
    (theme.appearance === 'light' || theme.appearance === 'dark') &&
    typeof theme.importedAt === 'string' &&
    Boolean(theme.variant) &&
    Boolean(theme.flatTokens)
  )
}

/**
 * Read the stored library. A malformed document starts an empty library and
 * quarantines the raw bytes into the library's own recovery key, mirroring the
 * appearance-preference recovery contract; individual invalid records are dropped,
 * not fatal.
 */
export function readCustomThemeLibrary(
  storage: AppearanceStorage | undefined
): readonly CustomThemeStored[] {
  if (!storage) return []
  try {
    // An empty value is no library, not a corrupt one.
    if (!storage.getItem(CUSTOM_THEME_LIBRARY_STORAGE_KEY)) return []
    const found = readVersionedRecord(storage, {
      key: CUSTOM_THEME_LIBRARY_STORAGE_KEY,
      version: CUSTOM_THEME_LIBRARY_VERSION,
      recoveryKey: CUSTOM_THEME_LIBRARY_RECOVERY_KEY,
    })
    if (found.status !== 'record') return []
    if (!Array.isArray(found.record.themes)) {
      quarantineRecord(storage, CUSTOM_THEME_LIBRARY_RECOVERY_KEY, found.raw, 'unsupported_record')
      return []
    }
    const themes = (found.record.themes as unknown[]).filter(isStoredTheme)
    replaceThemes(themes)
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
