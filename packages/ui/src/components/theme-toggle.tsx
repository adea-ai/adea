import { ThemeModeToggle, useTheme } from '@adea-ai/ui/components/theme/lazy'

/** The shared mode selector, controlled by the shared provider's persisted selection. */
export function ThemeToggle() {
  const theme = useTheme()

  return (
    <ThemeModeToggle
      mode={theme.selection().appearance}
      onModeChange={(appearance) => theme.setSelection({ appearance })}
      aria-label="Theme"
    />
  )
}
