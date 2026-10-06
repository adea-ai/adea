/* A searchable multi-select in a popover: people or labels. The host owns
 * what a toggle does — apply immediately (details panel) or collect locally
 * (new pull request). */
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@adea-ai/ui/components/ui/popover'
import { Check, Settings2 } from 'lucide-solid'
import { For, Show, createResource, createSignal, type JSX } from 'solid-js'

import { errorText } from '../client'

export type PickerOption = Readonly<{ value: string; hint?: string }>

export function Picker(props: {
  /** Plural noun for labels and announcements: "reviewers", "labels". */
  noun: string
  searchLabel: string
  selected: readonly string[]
  disabled?: boolean
  /** `icon` for a section header, `field` for a form row. */
  trigger: 'icon' | 'field'
  load(query: string): Promise<readonly PickerOption[]>
  onToggle(value: string, selected: boolean): void
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [options] = createResource(
    () => (open() ? { query: query() } : undefined),
    (source) => props.load(source.query)
  )
  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement={props.trigger === 'icon' ? 'left-start' : 'bottom-start'}
    >
      <Show
        when={props.trigger === 'icon'}
        fallback={
          <PopoverTrigger
            as={Button}
            type="button"
            variant="outline"
            size="sm"
            class="w-full justify-start"
            disabled={props.disabled}
          >
            <span class="dev-scm-truncate">
              {props.selected.length > 0 ? props.selected.join(', ') : `Add ${props.noun}`}
            </span>
          </PopoverTrigger>
        }
      >
        <PopoverTrigger
          as={ActionButton}
          type="button"
          variant="ghost"
          size="icon-xs"
          tooltip={`Edit ${props.noun}`}
          aria-label={`Edit ${props.noun}`}
          disabled={props.disabled}
        >
          <Settings2 aria-hidden="true" />
        </PopoverTrigger>
      </Show>
      <PopoverContent hideArrow>
        <div class="dev-scm-picker">
          <Input
            type="search"
            placeholder={props.searchLabel}
            aria-label={props.searchLabel}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div class="dev-scm-picker__list" role="group" aria-label={`Choose ${props.noun}`}>
            {/* A refetch keeps the rendered list mounted and updates it in
                place: `options()` holds the previous page while `loading`, so
                the Loading… caption is only for the first load — swapping the
                menu for it on every keystroke read as the menu flickering. */}
            <Show
              when={options() !== undefined}
              fallback={<span class="dev-scm-caption">Loading…</span>}
            >
              <Show when={options.error}>
                <span class="dev-scm-caption" role="alert">
                  {errorText(options.error)}
                </span>
              </Show>
              <For each={options() ?? []}>
                {(option) => {
                  const selected = () => props.selected.includes(option.value)
                  return (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="w-full justify-start"
                      aria-pressed={selected()}
                      disabled={props.disabled}
                      onClick={() => props.onToggle(option.value, !selected())}
                    >
                      <Show when={selected()} fallback={<span class="size-4" aria-hidden="true" />}>
                        <Check aria-hidden="true" />
                      </Show>
                      <span class="dev-scm-truncate">{option.value}</span>
                      <Show when={option.hint}>
                        <span class="dev-scm-caption dev-scm-truncate">{option.hint}</span>
                      </Show>
                    </Button>
                  )
                }}
              </For>
              <Show when={(options() ?? []).length === 0 && !options.error}>
                <span class="dev-scm-caption">No matches.</span>
              </Show>
            </Show>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function peopleLoader(
  load: (query: string) => Promise<{ items: readonly { login: string; name?: string }[] }>,
  exclude?: string
) {
  return async (query: string): Promise<readonly PickerOption[]> =>
    (await load(query)).items
      .filter((user) => user.login !== exclude)
      .map((user) => ({ value: user.login, ...(user.name ? { hint: user.name } : {}) }))
}

export function labelLoader(
  load: () => Promise<{ items: readonly { name: string; description?: string }[] }>
) {
  return async (query: string): Promise<readonly PickerOption[]> => {
    const needle = query.trim().toLowerCase()
    return (await load()).items
      .filter((label) => label.name.toLowerCase().includes(needle))
      .map((label) => ({
        value: label.name,
        ...(label.description ? { hint: label.description } : {}),
      }))
  }
}
