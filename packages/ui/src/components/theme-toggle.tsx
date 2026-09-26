import { Monitor, Moon, Sun } from 'lucide-solid'
import { For } from 'solid-js'

import { Button } from '@adea-ai/ui/components/ui/button'
import { cn } from '#lib/utils'
import { useTheme, type Theme } from './theme-provider'

const THEMES: ReadonlyArray<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: 'system', label: 'System theme', icon: Monitor },
  { value: 'light', label: 'Light theme', icon: Sun },
  { value: 'dark', label: 'Dark theme', icon: Moon },
]

/**
 * Compact sun/moon theme selector. Wired to the shared theme provider so the
 * choice persists across the app (localStorage) and applies to every scene.
 */
export function ThemeToggle(props: { class?: string }) {
  const { theme, setTheme } = useTheme()

  return (
    <div
      class={cn(
        'inline-flex items-center gap-2 rounded-full border border-input bg-background p-2',
        props.class
      )}
      role="radiogroup"
      aria-label="Theme"
    >
      <For each={THEMES}>
        {(option) => (
          <Button
            type="button"
            role="radio"
            aria-checked={theme() === option.value}
            aria-label={option.label}
            variant={theme() === option.value ? 'default' : 'ghost'}
            size="icon-sm"
            onClick={() => setTheme(option.value)}
            class="rounded-full"
          >
            <option.icon class="size-4" aria-hidden="true" />
          </Button>
        )}
      </For>
    </div>
  )
}
