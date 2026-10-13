/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 *
 * Adea's host adapter over the shared ThemeProvider. The shared provider owns what
 * a selection resolves to and paints (Zeron's appearance semantics, ported there);
 * Adea owns the stored V2 document (`appearance-codec.ts`), the imported-theme
 * library (`custom-theme-library.ts`), the native translucency capability, and the
 * V2 view of the context that the appearance editor and the shell consume. See
 * NOTICE and docs/decisions/0014-shared-theme-provider.md.
 */
import {
  createContext,
  createEffect,
  createSignal,
  useContext,
  type Context,
  type JSX,
  type ParentProps,
} from 'solid-js'

import {
  ThemeProvider as UiThemeProvider,
  useOptionalTheme as useOptionalUiTheme,
  type ThemeContextValue as UiThemeContextValue,
  type ThemeProviderProps as UiThemeProviderProps,
} from '@adea-ai/ui/components/theme'
import { defaultPreferenceStorage } from '@adea-ai/ui/lib/preference-store'
import { tokensAsHex } from '@adea-ai/ui/lib/themes'

import {
  APPEARANCE_ACCENT_CONTRAST_FLOOR,
  appearanceThemeScript,
  createAppearancePersistence,
  selectionFromPreferences,
  type AppearancePreferencesV2,
} from './appearance-codec'
import {
  customUiVariants,
  readCustomThemeLibrary,
  subscribeCustomThemes,
} from './custom-theme-library'

export type {
  AppearanceMode,
  AppearancePreferencesV2,
  ResolvedAppearance,
} from './appearance-codec'

/**
 * The shared theme context plus the V2 document seam the appearance editor works
 * in. Everything the shell reads (the selection, the resolved appearance, the
 * variant, `accentRolesFor`) is the shared context itself; only a V2-shaped write
 * and a V2-shaped draft preview are Adea's.
 */
export type AppearanceContextValue = Omit<UiThemeContextValue, 'preview'> & {
  /** Persist a field update immediately (Zeron's `SavePolicy::Immediate`). */
  update: (patch: Partial<AppearancePreferencesV2>) => void
  /**
   * Apply a draft against the visible app without persisting it. A committed change
   * while a draft is open (a zoom chord, the mode toggle) leaves the draft showing.
   */
  preview: (preferences: AppearancePreferencesV2 | undefined) => void
}

/*
 * The imported themes as a reactive source for the provider's `themes` prop. The
 * library lives on the host object; this signal is how a change to it reaches the
 * provider's registry.
 */
const [libraryRevision, setLibraryRevision] = createSignal(0)
let subscribedToLibrary = false

function libraryThemes() {
  if (!subscribedToLibrary) {
    subscribedToLibrary = true
    subscribeCustomThemes(() => setLibraryRevision((revision) => revision + 1))
  }
  libraryRevision()
  return customUiVariants()
}

/**
 * Everything the shared provider is told about Adea: where the preference lives, the
 * imported themes, and the policies that make Adea's document what it has always
 * been. A function so a test and the component build the same provider.
 */
export function appearanceProviderProps(
  options: { nativeTranslucency?: () => boolean } = {}
): Omit<UiThemeProviderProps, 'children'> {
  return {
    persistence: createAppearancePersistence(),
    themes: libraryThemes,
    // The web lane has no OS vibrancy and renders tokenized frosted surfaces instead
    // of pretending to it; a desktop host passes its capability.
    surface: { nativeTranslucency: options.nativeTranslucency ?? false },
    // The catalogue palette is `theme-variants.css`; the provider writes only the
    // accent, the terminal pin, the surface alpha, the fonts and imported themes.
    palette: 'stylesheet',
    accentContrastFloor: APPEARANCE_ACCENT_CONTRAST_FLOOR,
    editorRoles: 'floor',
    transformTokens: tokensAsHex,
    disableTransitionOnChange: true,
    fontZoom: true,
  }
}

/**
 * The V2 view of a shared theme context. Reads derive from the provider's selection;
 * writes go through its `setSelection`, so the shared provider remains the only
 * writer of the document and of storage.
 */
export function createAppearanceContext(ui: UiThemeContextValue): AppearanceContextValue {
  let draft: AppearancePreferencesV2 | undefined

  const preview = (next: AppearancePreferencesV2 | undefined) => {
    draft = next
    ui.preview(next ? selectionFromPreferences(next) : undefined)
  }

  // The shared provider ends a preview when the selection is committed. The editor's
  // draft is still open, though, so it keeps showing until the editor ends it.
  createEffect(() => {
    ui.selection()
    if (draft !== undefined && !ui.previewing()) ui.preview(selectionFromPreferences(draft))
  })

  return {
    ...ui,
    update: (patch) => ui.setSelection(selectionFromPreferences(patch)),
    preview,
  }
}

/*
 * The context lives on the global under a registered symbol, like the shared one:
 * a bundle that loads this module twice would otherwise give a provider from one
 * copy and a reader from the other two different context objects.
 */
const CONTEXT_KEY = Symbol.for('adea.app.theme')
type ContextHost = { [CONTEXT_KEY]?: Context<AppearanceContextValue | undefined> }

function appearanceContext(): Context<AppearanceContextValue | undefined> {
  const host = globalThis as ContextHost
  return (host[CONTEXT_KEY] ??= createContext<AppearanceContextValue>())
}

function AppearanceBridge(props: ParentProps) {
  const ui = useOptionalUiTheme()
  if (!ui) throw new Error('The appearance bridge must render inside the shared ThemeProvider.')
  const Context = appearanceContext()
  return <Context.Provider value={createAppearanceContext(ui)}>{props.children}</Context.Provider>
}

type ThemeProviderProps = ParentProps<{
  /**
   * Whether the host window can render OS translucency. The web lane keeps
   * the default `false` and renders tokenized frosted surfaces instead of
   * pretending to OS vibrancy.
   */
  nativeTranslucency?: boolean
}>

/**
 * Adea's appearance provider: the shared ThemeProvider configured for Adea's V2
 * document, with the V2 context on top. It owns the versioned appearance preference
 * (mode, independent light/dark themes, accent, surface) and applies it to the
 * document; the legacy single `theme` key migrates on read and is never deleted.
 */
export function ThemeProvider(props: ThemeProviderProps) {
  // Imported themes must be in the registry before the first resolution, or a
  // stored custom selection falls back to the default on mount.
  readCustomThemeLibrary(defaultPreferenceStorage())
  return (
    <UiThemeProvider
      {...appearanceProviderProps({ nativeTranslucency: () => props.nativeTranslucency ?? false })}
    >
      <AppearanceBridge>{props.children}</AppearanceBridge>
    </UiThemeProvider>
  )
}

/**
 * The appearance editor's view of the context: the shared context with the V2
 * `update` and `preview` seam. Shell code that only reads the theme (the selection,
 * the variant, `accentRolesFor`) uses the shared `useOptionalTheme` of
 * `@adea-ai/ui/components/theme` instead.
 */
export function useTheme(): AppearanceContextValue {
  const context = useContext(appearanceContext())
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider.')
  }
  return context
}

/**
 * Pre-paint appearance restore for server-rendered documents. Rendered in the
 * document head, it resolves the stored (or legacy) preference against the OS
 * and applies the document state before first paint so hydration never shows the
 * wrong theme.
 */
export function ThemeScript(): JSX.Element {
  return <script innerHTML={appearanceThemeScript()} />
}
