/*
 * The stable import path for Adea's appearance provider. The provider is the shared
 * ThemeProvider configured by the host adapter in `appearance-host.tsx`; this file
 * keeps the specifier the shell, the harnesses and the packages import.
 */
export {
  ThemeProvider,
  ThemeScript,
  useOptionalTheme,
  useTheme,
  type AppearanceContextValue,
  type AppearanceMode,
  type AppearancePreferencesV2,
  type ResolvedAppearance,
  type ResolvedTheme,
  type Theme,
} from './appearance-host'
