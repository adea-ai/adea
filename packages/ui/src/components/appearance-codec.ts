/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 *
 * The V2 appearance document keeps the preference schema, field-wise
 * normalization and legacy-key migration of Adea's accepted port of Zeron's
 * appearance preferences (https://github.com/zeronsh/zeron). See NOTICE and
 * docs/research/dev-view-donor-audit.md for source and behavior provenance.
 */
import { getAccent } from '@adea-ai/themes'

import {
  createVersionedPersistence,
  themeScript,
  type ThemePersistence,
  type ThemeSelection,
  type ThemeStorageSchema,
  type VersionedCodec,
} from '@adea-ai/ui/components/theme'
import { colorToHex, parseColor } from '@adea-ai/ui/lib/accent-roles'
import {
  DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS,
  normalizeAppearanceEditorFontSettings,
  type AppearanceEditorFontSettings,
} from '@adea-ai/ui/lib/appearance-font-settings'
import { normalizeSurface as normalizeThemeSurface } from '@adea-ai/ui/lib/theme-surface'
import { isThemeAccentId } from '@adea-ai/ui/lib/themes'

/**
 * The versioned client appearance preference (Dev Runtime spec,
 * "Appearance and App Library"). Stored as one JSON document; the legacy
 * single `theme` key migrates into it without deleting the old value.
 *
 * The document is Adea's product schema. The shared ThemeProvider owns what a
 * selection resolves to and paints; this module owns what is stored, under which
 * keys, and how an unreadable or older record is corrected. The stored bytes are
 * the same as they were before the provider was shared.
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
  /** A built-in preset id, a theme-carried `ansi-<slot>` id, or a validated `#rrggbb` color. Legacy documents may still store `'theme'`; normalization migrates it. */
  accent: 'theme' | string
  surface: SurfacePreference
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
 * malformed or future-version document is quarantined here, before any write can
 * touch the main key, so saving valid preferences later can never destroy the
 * user's unread data.
 */
export const APPEARANCE_RECOVERY_STORAGE_KEY = 'appearance.recovery'
/** The imported-theme library the boot script reads for a stored custom selection. */
export const APPEARANCE_LIBRARY_STORAGE_KEY = 'appearance.library'

/**
 * The default accent is the catalogue's Violet brand preset, one of the six
 * accents, not a separate "theme default" entry beside them. Documents stored
 * before the default became a preset carry `'theme'` (the theme's own primary);
 * normalization migrates those to this id, and an unknown value degrades to it too.
 */
export const DEFAULT_ACCENT_PRESET_ID = 'violet'

/**
 * The contrast an accent is held to against any theme, the imported ones included.
 * The catalogue's presets already clear it on the catalogue's own themes, so the
 * floor changes no preset there; it exists for custom colours and imported themes.
 */
export const APPEARANCE_ACCENT_CONTRAST_FLOOR = 3

export const defaultAppearancePreferences: AppearancePreferencesV2 = Object.freeze({
  version: 2,
  mode: 'system',
  lightThemeId: 'adea-light',
  darkThemeId: 'adea-dark',
  terminalThemeId: 'theme',
  accent: DEFAULT_ACCENT_PRESET_ID,
  surface: 'opaque',
  reduceTransparency: false,
})

/*
 * Preference storage: normalization and legacy migration.
 */

function normalizeMode(value: unknown): AppearanceMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function normalizeSurface(value: unknown): SurfacePreference {
  return normalizeThemeSurface(value) ?? 'opaque'
}

function normalizeThemeId(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

function normalizeAccent(value: unknown): string {
  // `'theme'` was the pre-preset default ("use the theme's own primary").
  // The default accent is now the catalogue's Violet preset, so a stored
  // legacy value migrates instead of surviving as an unpickable state.
  if (value === 'theme' || typeof value !== 'string') return DEFAULT_ACCENT_PRESET_ID
  if (getAccent(value) || isThemeAccentId(value)) return value
  // A custom colour has one stored spelling, `#rrggbb`: the shared provider reads
  // nothing else. Short forms expand and an alpha channel is dropped.
  const parsed = parseColor(value)
  return parsed ? colorToHex({ ...parsed, a: 255 }) : DEFAULT_ACCENT_PRESET_ID
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

/*
 * The shared provider's selection and the V2 document are two views of one
 * preference. These two functions are the whole mapping between them.
 */

/**
 * A V2 preference, or a patch of one, as a selection patch. Only the fields present
 * are returned: a patch key left `undefined` would overwrite the selection's value.
 */
export function selectionFromPreferences(
  preferences: Partial<AppearancePreferencesV2>
): Partial<ThemeSelection> {
  return {
    ...(preferences.mode === undefined ? {} : { appearance: preferences.mode }),
    ...(preferences.lightThemeId === undefined ? {} : { lightThemeId: preferences.lightThemeId }),
    ...(preferences.darkThemeId === undefined ? {} : { darkThemeId: preferences.darkThemeId }),
    ...(preferences.terminalThemeId === undefined
      ? {}
      : { terminalThemeId: preferences.terminalThemeId }),
    // The legacy `'theme'` spelling is the default preset everywhere a draft, a
    // stored record or a direct update can reach: the provider's own `theme` means
    // "the variant's primary", which no V2 preference can select.
    ...(preferences.accent === undefined
      ? {}
      : {
          accent: preferences.accent === 'theme' ? DEFAULT_ACCENT_PRESET_ID : preferences.accent,
        }),
    ...(preferences.surface === undefined ? {} : { surface: preferences.surface }),
    ...(preferences.reduceTransparency === undefined
      ? {}
      : { reduceTransparency: preferences.reduceTransparency }),
    ...(preferences.fonts === undefined ? {} : { fonts: preferences.fonts }),
  }
}

/** The V2 view of the provider's committed selection. */
export function preferencesFromSelection(selection: ThemeSelection): AppearancePreferencesV2 {
  return {
    version: 2,
    mode: selection.appearance,
    lightThemeId: selection.lightThemeId,
    darkThemeId: selection.darkThemeId,
    terminalThemeId: selection.terminalThemeId ?? 'theme',
    accent: selection.accent === 'theme' ? DEFAULT_ACCENT_PRESET_ID : selection.accent,
    surface: selection.surface ?? 'opaque',
    reduceTransparency: selection.reduceTransparency === true,
    ...(selection.fonts === undefined ? {} : { fonts: selection.fonts }),
  }
}

function sameFonts(left: AppearanceEditorFontSettings, right: AppearanceEditorFontSettings) {
  return (['ui', 'content', 'code'] as const).every(
    (axis) => left[axis].family === right[axis].family && left[axis].size === right[axis].size
  )
}

/*
 * The storage schema and codec.
 */

/**
 * Where the V2 document lives. One object feeds the persistence and the boot
 * script, so the two cannot disagree about a key, a version or a field name.
 */
export const appearanceSchema = {
  key: APPEARANCE_STORAGE_KEY,
  version: 2,
  appearanceField: 'mode',
  legacyAppearanceKey: LEGACY_THEME_STORAGE_KEY,
  libraryKey: APPEARANCE_LIBRARY_STORAGE_KEY,
  recoveryKey: APPEARANCE_RECOVERY_STORAGE_KEY,
} satisfies ThemeStorageSchema

/** What a store with nothing readable answers: Adea's fresh-install preference. */
function installDefaults(): Partial<ThemeSelection> {
  return selectionFromPreferences(defaultAppearancePreferences)
}

/**
 * The document written for a selection: exactly the V2 fields, in the order they
 * have always been written. `fonts` is written when the record last read or written
 * carried it, or when the text settings differ from the defaults, so a document
 * whose text was never touched keeps the bytes it had.
 */
export function appearanceDocument(
  next: ThemeSelection,
  previous?: Readonly<Record<string, unknown>>
): AppearancePreferencesV2 {
  const fonts = normalizeAppearanceEditorFontSettings(next.fonts, next.font).settings
  const keepFonts =
    previous?.fonts !== undefined || !sameFonts(fonts, DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS)
  return {
    ...preferencesFromSelection({ ...next, fonts: undefined }),
    ...(keepFonts ? { fonts } : {}),
  }
}

export const adeaV2Codec: VersionedCodec<AppearancePreferencesV2> = {
  // The engine has already checked the shape and `version`, so every field here is
  // corrected one by one: an unknown value inside a readable record is repaired, not
  // fatal. A theme id the catalogue lacks is kept verbatim; the provider resolves it.
  decode: (record) => selectionFromPreferences(normalizeAppearancePreferences(record).value),
  fromLegacy: (value) => {
    const migrated = migrateLegacyThemeValue(value)
    return migrated ? selectionFromPreferences(migrated) : undefined
  },
  defaults: installDefaults,
  encode: appearanceDocument,
}

/** The provider's persistence over the V2 document. */
export function createAppearancePersistence(): ThemePersistence {
  return createVersionedPersistence(appearanceSchema, adeaV2Codec)
}

/**
 * The boot script rendered in the document head: the shared `themeScript` over this
 * schema, so first paint and the mounted provider read one document. The default
 * accent matches the codec's fresh-install accent, so a fresh page paints the
 * accent the provider will keep.
 */
export function appearanceThemeScript(): string {
  return themeScript({
    ...appearanceSchema,
    defaultAccent: DEFAULT_ACCENT_PRESET_ID,
    surface: true,
    palette: 'stylesheet',
  })
}
