import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type JSX,
  type ParentProps,
} from 'solid-js'

import {
  appearanceThemeScript,
  applyAppearanceToDocument,
  DARK_QUERY,
  defaultAppearancePreferences,
  type AppearanceMode,
  type AppearancePreferencesV2,
  type ResolvedAppearance,
  readAppearancePreferences,
  REDUCED_TRANSPARENCY_QUERY,
  resolveAppearanceState,
  writeAppearancePreferences,
} from './appearance'

export type Theme = AppearanceMode
export type ResolvedTheme = ResolvedAppearance

export type { AppearanceMode, AppearancePreferencesV2, ResolvedAppearance } from './appearance'

type ThemeContextValue = {
  /** The persisted v2 appearance preferences. */
  preferences: Accessor<AppearancePreferencesV2>
  /** Mode after combining the user choice with the OS report. */
  resolvedMode: Accessor<ResolvedAppearance>
  /** The active theme variant id (`documentElement.dataset.theme`). */
  variantId: Accessor<string>
  /** Surface after reduced-transparency and capability resolution. */
  effectiveSurface: Accessor<'opaque' | 'frosted' | 'translucent'>
  /** True while the OS or the user forces opaque surfaces. */
  reduceTransparencyActive: Accessor<boolean>
  /** Persist a field update immediately (Zeron's `SavePolicy::Immediate`). */
  update: (patch: Partial<AppearancePreferencesV2>) => void
  /** Apply a draft against the visible app without persisting it. */
  preview: (preferences: AppearancePreferencesV2 | undefined) => void

  /** Legacy single-mode seam (settings toggle and existing consumers). */
  theme: Accessor<Theme>
  resolvedTheme: Accessor<ResolvedTheme>
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue>()

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches
}

function systemReducesTransparency(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches
}

type ThemeProviderProps = ParentProps<{
  defaultTheme?: Theme
  disableTransitionOnChange?: boolean
  /**
   * Whether the host window can render OS translucency. The web lane keeps
   * the default `false` and renders tokenized frosted surfaces instead of
   * pretending to OS vibrancy.
   */
  nativeTranslucency?: boolean
}>

/**
 * The shared Solid appearance provider. It owns the versioned appearance
 * preference (mode, independent light/dark themes, accent, surface) on top of
 * the contract the previous provider exposed to the token layer: a `dark`
 * class on the document element plus a `color-scheme` style, persisted in
 * `localStorage` and defaulting to the system preference. The legacy single
 * `theme` key migrates on read and is never deleted.
 */
export function ThemeProvider(props: ThemeProviderProps) {
  const storage = typeof window === 'undefined' ? undefined : window.localStorage
  const stored = readAppearancePreferences(storage)
  // A legacy or default record keeps the historical `defaultTheme` escape
  // hatch meaningful for embedders.
  const initial =
    stored === defaultAppearancePreferences && props.defaultTheme
      ? { ...stored, mode: props.defaultTheme }
      : stored
  const [preferences, setPreferences] = createSignal<AppearancePreferencesV2>(initial)
  const [prefersDark, setPrefersDark] = createSignal(systemPrefersDark())
  const [osReducedTransparency, setOsReducedTransparency] = createSignal(
    systemReducesTransparency()
  )
  const nativeTranslucency = () => props.nativeTranslucency ?? false

  if (typeof window !== 'undefined') {
    const darkMedia = window.matchMedia(DARK_QUERY)
    const onDarkChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches)
    darkMedia.addEventListener('change', onDarkChange)
    onCleanup(() => darkMedia.removeEventListener('change', onDarkChange))

    const transparencyMedia = window.matchMedia(REDUCED_TRANSPARENCY_QUERY)
    const onTransparencyChange = (event: MediaQueryListEvent) =>
      setOsReducedTransparency(event.matches)
    transparencyMedia.addEventListener('change', onTransparencyChange)
    onCleanup(() => transparencyMedia.removeEventListener('change', onTransparencyChange))
  }

  const resolvedState = () =>
    resolveAppearanceState(preferences(), {
      systemAppearance: prefersDark() ? 'dark' : 'light',
      osReducedTransparency: osReducedTransparency(),
      nativeTranslucency: nativeTranslucency(),
    })

  const persist = (next: AppearancePreferencesV2) => {
    setPreferences(next)
    writeAppearancePreferences(storage, next)
  }

  createEffect(() => {
    applyResolved(resolvedState(), props.disableTransitionOnChange ?? true)
  })

  const update = (patch: Partial<AppearancePreferencesV2>) => {
    persist({ ...preferences(), ...patch })
  }

  const preview = (draft: AppearancePreferencesV2 | undefined) => {
    if (!draft) {
      applyResolved(resolvedState(), props.disableTransitionOnChange ?? true)
      return
    }
    applyResolved(
      resolveAppearanceState(draft, {
        systemAppearance: prefersDark() ? 'dark' : 'light',
        osReducedTransparency: osReducedTransparency(),
        nativeTranslucency: nativeTranslucency(),
      }),
      props.disableTransitionOnChange ?? true
    )
  }

  // Legacy seam: the single `theme` value is the v2 mode.
  const theme = (): Theme => preferences().mode
  const resolvedTheme = (): ResolvedTheme => resolvedState().resolvedMode
  const setTheme = (next: Theme) => update({ mode: next })

  return (
    <ThemeContext.Provider
      value={{
        preferences,
        resolvedMode: resolvedTheme,
        variantId: () => resolvedState().variant.id,
        effectiveSurface: () => resolvedState().effectiveSurface,
        reduceTransparencyActive: () => resolvedState().reduceTransparencyActive,
        update,
        preview,
        theme,
        resolvedTheme,
        setTheme,
      }}
    >
      {props.children}
    </ThemeContext.Provider>
  )
}

/**
 * Applies the resolved theme to the document and suppresses transitions for the
 * frame that carries the change, so a theme switch cannot animate page-wide.
 */
function applyResolved(
  state: ReturnType<typeof resolveAppearanceState>,
  disableTransitionOnChange: boolean
): void {
  if (typeof document === 'undefined') return

  let restoreTransitions: (() => void) | undefined

  if (disableTransitionOnChange) {
    const style = document.createElement('style')
    style.appendChild(document.createTextNode('*{transition:none !important}'))
    document.head.appendChild(style)
    void style.offsetHeight
    restoreTransitions = () => style.remove()
  }

  applyAppearanceToDocument(document, state)

  if (restoreTransitions) {
    requestAnimationFrame(() => requestAnimationFrame(() => restoreTransitions?.()))
  }
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider.')
  }
  return context
}

/**
 * Pre-paint appearance restore for server-rendered documents. Rendered in the
 * document head, it resolves the stored (or legacy) preference against the OS
 * and applies the palette before first paint so hydration never shows the
 * wrong theme.
 */
export function ThemeScript(): JSX.Element {
  return <script innerHTML={appearanceThemeScript()} />
}
