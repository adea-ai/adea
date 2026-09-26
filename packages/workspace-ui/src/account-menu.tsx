import {
  CircleHelp,
  Info,
  LogIn,
  LogOut,
  Megaphone,
  RefreshCw,
  Settings2,
  Smartphone,
  UserRound,
} from 'lucide-solid'
import { For, Show } from 'solid-js'

import { Button } from '@adea-ai/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@adea-ai/app-ui/components/ui/dropdown-menu'

import { accountMenuItemsForPlatform, accountSessionItem } from './account-menu-model'

type AccountMenuProps = {
  authenticated: boolean
  busy?: boolean
  /** Fires on hover/focus of the trigger — a chance to prefetch menu targets. */
  onIntent?: () => void
  onOpenUpdates?: () => void
  onOpenAbout: () => void
  onOpenSettings: () => void
  onSignIn: () => void
  onSignOut: () => void
  platform: 'desktop' | 'web'
}

const icons = {
  mobile: Smartphone,
  settings: Settings2,
  about: Info,
  help: CircleHelp,
  feedback: Megaphone,
  updates: RefreshCw,
} as const

export function AccountMenu(props: AccountMenuProps) {
  const sessionItem = () => accountSessionItem(props.authenticated)
  const visibleMenuItems = () => accountMenuItemsForPlatform(props.platform)

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        as={Button}
        variant="ghost"
        size="icon-lg"
        class="global-rail__button global-rail__account-trigger"
        aria-label="User settings"
        onFocus={() => props.onIntent?.()}
        onPointerEnter={() => props.onIntent?.()}
      >
        <UserRound aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent class="global-account-menu" side="top" align="start" sideOffset={0}>
        <DropdownMenuGroup>
          <For each={visibleMenuItems()}>
            {(item) => {
              const Icon = icons[item.id]
              const onSelect = () =>
                item.id === 'settings'
                  ? props.onOpenSettings()
                  : item.id === 'about'
                    ? props.onOpenAbout()
                    : item.id === 'updates'
                      ? props.onOpenUpdates?.()
                      : undefined
              return (
                <DropdownMenuItem disabled={item.disabled} onSelect={onSelect}>
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                  <Show when={item.id === 'settings'}>
                    <DropdownMenuShortcut aria-hidden="true">⌘,</DropdownMenuShortcut>
                  </Show>
                </DropdownMenuItem>
              )
            }}
          </For>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={props.busy}
            onSelect={props.authenticated ? props.onSignOut : props.onSignIn}
          >
            <Show when={props.authenticated} fallback={<LogIn aria-hidden="true" />}>
              <LogOut aria-hidden="true" />
            </Show>
            <span>{sessionItem().label}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
