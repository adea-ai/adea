import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { SideRailButton } from '@adea-ai/ui/components/layout/side-rail'
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
import { For, Show, onCleanup, type JSX } from 'solid-js'

import { accountMenuItemsForPlatform } from './account-menu-model'

type AccountMenuProps = {
  authenticated: boolean
  busy?: boolean
  /** Fires on hover/focus of the trigger — a chance to prefetch menu targets. */
  onIntent?: () => void
  onOpenUpdates?: (opener: HTMLButtonElement | undefined) => void
  onOpenAbout: () => void
  onOpenSettings: () => void
  onSignIn: () => void
  onSignOut: () => void
  platform: 'desktop' | 'web'
}

const ITEM_ICONS: Record<string, JSX.Element> = {
  mobile: <Smartphone aria-hidden="true" />,
  about: <Info aria-hidden="true" />,
  help: <CircleHelp aria-hidden="true" />,
  feedback: <Megaphone aria-hidden="true" />,
  updates: <RefreshCw aria-hidden="true" />,
  settings: <Settings2 aria-hidden="true" />,
}

/**
 * The rail's account and settings menu, composed on the shared primitives so it
 * reads as part of the rail: the trigger is a rail row with the same flush
 * hover tip as every other rail item, and the menu opens to the right of the
 * icon, bottom-aligned with it, instead of floating above the footer.
 */
export function AccountMenu(props: AccountMenuProps) {
  const items = () =>
    accountMenuItemsForPlatform(props.platform).map((item) => ({
      id: item.id,
      label: item.label,
      disabled: item.disabled,
      shortcut: item.id === 'settings' ? '\u2318,' : undefined,
      icon: ITEM_ICONS[item.id],
      onSelect:
        item.id === 'about'
          ? () => props.onOpenAbout()
          : item.id === 'settings'
            ? () => props.onOpenSettings()
            : undefined,
      onSelectAfterClose:
        item.id === 'updates' && props.onOpenUpdates
          ? (trigger: HTMLButtonElement | undefined) => props.onOpenUpdates?.(trigger)
          : undefined,
    }))

  let trigger: HTMLButtonElement | undefined
  let pendingAfterClose:
    | { callback: NonNullable<ReturnType<typeof items>[number]['onSelectAfterClose']> }
    | undefined
  let scheduledAfterClose:
    | { callback: NonNullable<ReturnType<typeof items>[number]['onSelectAfterClose']> }
    | undefined
  onCleanup(() => {
    pendingAfterClose = undefined
    scheduledAfterClose = undefined
  })

  return (
    <DropdownMenu
      modal={false}
      placement="right-end"
      gutter={4}
      onOpenChange={(open) => {
        if (!open) return
        // SideRailButton owns its ref, so capture the trigger while focus is
        // still on it: the updates flow needs it as the stable opener after
        // the menu's close-focus cycle.
        trigger =
          document.activeElement instanceof HTMLButtonElement ? document.activeElement : undefined
      }}
    >
      <DropdownMenuTrigger
        as={SideRailButton}
        label="User settings"
        class="global-rail__account-trigger"
        onPointerEnter={() => props.onIntent?.()}
        onFocus={() => props.onIntent?.()}
      >
        <UserRound aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        class="global-rail__account-menu min-w-56 max-h-(--kb-popper-available-height) overflow-x-hidden overflow-y-auto"
        onCloseAutoFocus={(event) => {
          const selection = pendingAfterClose
          pendingAfterClose = undefined
          if (!selection) return

          event.preventDefault()
          scheduledAfterClose = selection
          queueMicrotask(() => {
            if (scheduledAfterClose !== selection) return
            scheduledAfterClose = undefined
            selection.callback(trigger)
          })
        }}
      >
        <DropdownMenuGroup>
          <For each={items()}>
            {(item) => (
              <DropdownMenuItem
                disabled={item.disabled}
                onSelect={() => {
                  pendingAfterClose = item.onSelectAfterClose
                    ? { callback: item.onSelectAfterClose }
                    : undefined
                  item.onSelect?.()
                }}
              >
                {item.icon}
                <span>{item.label}</span>
                <Show when={item.shortcut}>
                  <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>
                </Show>
              </DropdownMenuItem>
            )}
          </For>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={props.busy}
            onSelect={() => (props.authenticated ? props.onSignOut?.() : props.onSignIn?.())}
          >
            <Show when={props.authenticated} fallback={<LogIn aria-hidden="true" />}>
              <LogOut aria-hidden="true" />
            </Show>
            <span>{props.authenticated ? 'Sign out' : 'Sign in'}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
