// The terminal toolbar's two menus: the shell menu (start a terminal with a
// shell, choose the device default) and the toolbar customizer. Both only
// present what the host advertised and what this device saved; neither starts
// a process by itself.
import type { ShellProfile } from '@adea-ai/types/dev-runtime'
import { ChevronDown, SlidersHorizontal, SquareTerminal } from 'lucide-solid'
import { For, Show, type JSX } from 'solid-js'

import {
  TOOLBAR_ITEM_IDS,
  TOOLBAR_ITEM_LABELS,
  isDefaultToolbar,
  resetToolbar,
  resolveDefaultShellProfileId,
  setDefaultShellProfile,
  setToolbarBlocks,
  setToolbarItem,
  toolbarPreferences,
  updateToolbarPreferences,
} from './toolbar-preferences'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Text } from '@adea-ai/ui/components/ui/typography'

export function ShellMenu(props: {
  profiles: readonly ShellProfile[]
  /** The profile the terminal in this pane was started with, when the host reports it. */
  currentProfileId?: string
  /** Absent when this surface cannot create terminals; the rows then only inform. */
  onNewTerminalWithShell?: (profileId: string) => void
}): JSX.Element {
  const current = () => props.profiles.find((profile) => profile.id === props.currentProfileId)
  const defaultId = () =>
    resolveDefaultShellProfileId(props.profiles, toolbarPreferences().defaultShellProfileId) ??
    props.profiles[0]?.id
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        as={Button}
        type="button"
        variant="outline"
        size="xs"
        data-terminal-shell-menu=""
        aria-label={current() ? `Shell: ${current()!.label}. Open shell menu` : 'Open shell menu'}
      >
        <SquareTerminal aria-hidden="true" />
        {current()?.label ?? 'Shell'}
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent hideArrow placement="bottom-start">
        <DropdownMenuGroup>
          <DropdownMenuLabel>New terminal with</DropdownMenuLabel>
          <For each={props.profiles}>
            {(profile) => (
              <DropdownMenuItem
                disabled={props.onNewTerminalWithShell === undefined}
                onSelect={() => props.onNewTerminalWithShell?.(profile.id)}
                aria-label={`New terminal with ${profile.label}`}
              >
                <span class="flex min-w-0 flex-1 flex-col">
                  <span>{profile.label}</span>
                  <Text variant="code" tone="muted">
                    {profile.argv[0]}
                  </Text>
                </span>
                <Show when={profile.id === props.currentProfileId}>
                  <Text variant="caption" tone="muted">
                    This terminal
                  </Text>
                </Show>
              </DropdownMenuItem>
            )}
          </For>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Default for new terminals</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={defaultId()}
            onChange={(profileId) =>
              updateToolbarPreferences((saved) =>
                setDefaultShellProfile(saved, typeof profileId === 'string' ? profileId : undefined)
              )
            }
          >
            <For each={props.profiles}>
              {(profile) => (
                <DropdownMenuRadioItem value={profile.id} closeOnSelect={false}>
                  {profile.label}
                </DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <div class="px-2 py-1.5">
          <Text variant="caption" tone="muted">
            Saved on this device for every workspace. A terminal that is already running keeps its
            shell.
          </Text>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function CustomizeToolbarMenu(): JSX.Element {
  const preferences = toolbarPreferences
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        as={ActionButton}
        type="button"
        variant="ghost"
        size="icon-sm"
        tooltip="Customize toolbar"
        aria-label="Customize toolbar"
        data-terminal-customize=""
      >
        <SlidersHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent hideArrow placement="bottom-end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Toolbar items</DropdownMenuLabel>
          <For each={TOOLBAR_ITEM_IDS}>
            {(id) => (
              <DropdownMenuCheckboxItem
                checked={preferences().items[id]}
                closeOnSelect={false}
                onChange={(visible) =>
                  updateToolbarPreferences((saved) => setToolbarItem(saved, id, visible))
                }
              >
                {TOOLBAR_ITEM_LABELS[id].label}
              </DropdownMenuCheckboxItem>
            )}
          </For>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Below the toolbar</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={preferences().blocks}
            closeOnSelect={false}
            onChange={(visible) =>
              updateToolbarPreferences((saved) => setToolbarBlocks(saved, visible))
            }
          >
            {TOOLBAR_ITEM_LABELS.blocks.label}
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={isDefaultToolbar(preferences())}
          onSelect={() => updateToolbarPreferences(resetToolbar)}
        >
          Reset to default
        </DropdownMenuItem>
        <div class="px-2 py-1.5">
          <Text variant="caption" tone="muted">
            Saved on this device
          </Text>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
