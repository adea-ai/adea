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

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

type ThemeContextValue = {
  theme: Accessor<Theme>
  resolvedTheme: Accessor<ResolvedTheme>
  setTheme: (theme: Theme) => void
}

const STORAGE_KEY = 'theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

const ThemeContext = createContext<ThemeContextValue>()

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches
}

/**
 * Applies the resolved theme to the document and suppresses transitions for the
 * frame that carries the change, so a theme switch cannot animate page-wide.
 */
function applyTheme(theme: ResolvedTheme, disableTransitionOnChange: boolean): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  let restoreTransitions: (() => void) | undefined

  if (disableTransitionOnChange) {
    const style = document.createElement('style')
    style.appendChild(document.createTextNode('*{transition:none !important}'))
    document.head.appendChild(style)
    void style.offsetHeight
    restoreTransitions = () => style.remove()
  }

  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme

  if (restoreTransitions) {
    requestAnimationFrame(() => requestAnimationFrame(() => restoreTransitions?.()))
  }
}

type ThemeProviderProps = ParentProps<{
  defaultTheme?: Theme
  disableTransitionOnChange?: boolean
}>

/**
 * The shared Solid theme provider. It owns the same contract the previous
 * provider exposed to the token layer: a `dark` class on the document element
 * plus a `color-scheme` style, persisted in `localStorage` and defaulting to
 * the system preference.
 */
export function ThemeProvider(props: ThemeProviderProps) {
  const [theme, setThemeSignal] = createSignal<Theme>(props.defaultTheme ?? readStoredTheme())
  const [prefersDark, setPrefersDark] = createSignal(systemPrefersDark())

  const resolvedTheme = (): ResolvedTheme => {
    const current = theme()
    if (current === 'system') return prefersDark() ? 'dark' : 'light'
    return current
  }

  if (typeof window !== 'undefined') {
    const media = window.matchMedia(DARK_QUERY)
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches)
    media.addEventListener('change', onChange)
    onCleanup(() => media.removeEventListener('change', onChange))
  }

  createEffect(() => {
    applyTheme(resolvedTheme(), props.disableTransitionOnChange ?? true)
  })

  const setTheme = (next: Theme) => {
    setThemeSignal(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // A blocked storage API must not break the in-memory theme.
    }
  }

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {props.children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider.')
  }
  return context
}

/**
 * Pre-paint theme restore for server-rendered documents. Rendered in the
 * document head, it applies the stored or system theme before first paint so
 * hydration never shows the wrong palette.
 */
export function ThemeScript(): JSX.Element {
  const script = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('${DARK_QUERY}').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light'}catch(e){}})();`
  return <script innerHTML={script} />
}
