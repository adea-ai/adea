import { ThemeModeToggle } from '@adea-ai/ui/components/theme'
import { useTheme } from './theme-provider'

/** The shared mode selector controlled by Adea's persisted host preference. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return <ThemeModeToggle mode={theme()} onModeChange={setTheme} aria-label="Theme" />
}
