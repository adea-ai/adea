import { For } from 'solid-js'
import { cn } from '../lib/utils'

/**
 * Split a written chord into one entry per key cap. Every character is a key:
 * "⌘K" renders as `⌘` + `K`, and a longer chord like "⇧⌘P" stays three caps
 * wide, which matches how the system draws chords in menus.
 */
export function shortcutKeyList(keys: string): string[] {
  return [...keys]
}

export type ShortcutKeysProps = {
  /** The chord as it is drawn, e.g. "⌘K" or "⌘,". One cap per character. */
  keys: string
  class?: string
}

/**
 * ShortcutKeys.
 *
 * The app-wide way to draw a keyboard chord: each key becomes its own outlined
 * cap, the way system menus draw them, instead of one run of monospace text
 * that reads as a label rather than as keys. Decoration only — the accessible
 * name stays on the control the chord belongs to, which should also carry
 * `aria-keyshortcuts`.
 */
export function ShortcutKeys(props: ShortcutKeysProps) {
  return (
    <span aria-hidden="true" class={cn('inline-flex items-center gap-0.5', props.class)}>
      <For each={shortcutKeyList(props.keys)}>
        {(key) => (
          <kbd class="inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-border bg-muted/40 px-0.5 font-mono text-2xs leading-none text-muted-foreground">
            {key}
          </kbd>
        )}
      </For>
    </span>
  )
}
