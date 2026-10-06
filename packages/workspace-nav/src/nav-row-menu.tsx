import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Ellipsis } from 'lucide-solid'
import { For, Show } from 'solid-js'

import type { NavMenuItem, NavMenuItemId } from './adapters'

/** A row's ⋯ menu, rendered from the adapter's menu data. */
export function NavRowMenu(props: {
  /** The trigger's accessible name and tooltip, e.g. "Options for adea". */
  label: string
  items: readonly NavMenuItem[]
  onSelect: (id: NavMenuItemId) => void
  portalMount?: HTMLElement
  /** False inside a modal sheet, where a focus tooltip would swallow Escape. */
  tooltips?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        as={ActionButton}
        variant="ghost"
        size="icon-xs"
        tooltip={props.tooltips === false ? undefined : props.label}
        aria-label={props.label}
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        hideArrow
        placement="bottom-end"
        gutter={4}
        portalMount={props.portalMount}
        class="max-h-(--kb-popper-available-height) overflow-x-hidden overflow-y-auto"
      >
        <For each={props.items}>
          {(item) => (
            <>
              <Show when={item.separatorBefore}>
                <DropdownMenuSeparator />
              </Show>
              <DropdownMenuItem
                variant={item.destructive ? 'destructive' : 'default'}
                data-menu-item-id={item.id}
                onSelect={() => props.onSelect(item.id)}
              >
                {item.label}
              </DropdownMenuItem>
            </>
          )}
        </For>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
