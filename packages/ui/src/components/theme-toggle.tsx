'use client'

import { useSyncExternalStore } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '#components/ui/button'
import { cn } from '#lib/utils'

/**
 * Compact sun/moon theme selector. Wired to the next-themes provider so the
 * choice persists across the app (localStorage) and applies to every scene.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false
  )

  // next-themes resolves the saved/system theme after mount. Use the stable
  // light presentation for both SSR and the first client render so the
  // aria/class attributes cannot mismatch during hydration.
  const selectedTheme = mounted ? theme : 'system'

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-input bg-background p-1.5',
        className
      )}
      role="radiogroup"
      aria-label="Theme"
    >
      <Button
        type="button"
        role="radio"
        aria-checked={selectedTheme === 'system'}
        aria-label="System theme"
        variant={selectedTheme === 'system' ? 'default' : 'ghost'}
        size="icon-sm"
        onClick={() => setTheme('system')}
        className="rounded-full"
      >
        <Monitor className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        role="radio"
        aria-checked={selectedTheme === 'light'}
        aria-label="Light theme"
        variant={selectedTheme === 'light' ? 'default' : 'ghost'}
        size="icon-sm"
        onClick={() => setTheme('light')}
        className="rounded-full"
      >
        <Sun className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        role="radio"
        aria-checked={selectedTheme === 'dark'}
        aria-label="Dark theme"
        variant={selectedTheme === 'dark' ? 'default' : 'ghost'}
        size="icon-sm"
        onClick={() => setTheme('dark')}
        className="rounded-full"
      >
        <Moon className="size-4" aria-hidden="true" />
      </Button>
    </div>
  )
}
