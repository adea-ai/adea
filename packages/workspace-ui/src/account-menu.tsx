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
import { settingsShortcutLabel } from './keyboard-shortcuts'
import { updatePending } from './update-pending'

type AccountMenuProps = {
  authenticated: boolean
  busy?: boolean
  /** Fires on hover/focus of the trigger — a chance to prefetch menu targets. */
  onIntent?: () => void
  onOpenUpdates?: (opener: HTMLButtonElement | undefined) => void
  onOpenHelp?: (opener: HTMLButtonElement | undefined) => void
  onOpenFeedback: (opener: HTMLButtonElement | undefined) => void
  onOpenAbout: (opener: HTMLButtonElement | undefined) => void
  onOpenSettings: (opener: HTMLButtonElement | undefined) => void
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
      disabled: item.id === 'help' ? !props.onOpenHelp : item.disabled,
      // The advertised chord follows the running OS — the settings binding
      // accepts Meta and Ctrl alike, so Windows and Linux see Ctrl, not ⌘.
      shortcut: item.id === 'settings' ? settingsShortcutLabel() : undefined,
      icon: ITEM_ICONS[item.id],
      // Settings and About ride onSelectAfterClose (below) like the other
      // panels: they open dialogs, and opening one while the menu's
      // close-focus cycle is still running both races the dialog's opener
      // capture and leaves the closing menu overlay competing with the
      // dialog's focus restore. Handing the trigger over after the cycle is
      // the contract the updates/feedback/help panels already use.
      onSelectAfterClose:
        item.id === 'updates' && props.onOpenUpdates
          ? (trigger: HTMLButtonElement | undefined) => props.onOpenUpdates?.(trigger)
          : item.id === 'feedback'
            ? (trigger: HTMLButtonElement | undefined) => props.onOpenFeedback(trigger)
            : item.id === 'help' && props.onOpenHelp
              ? (trigger: HTMLButtonElement | undefined) => props.onOpenHelp?.(trigger)
              : item.id === 'settings'
                ? (trigger: HTMLButtonElement | undefined) => props.onOpenSettings(trigger)
                : item.id === 'about'
                  ? (trigger: HTMLButtonElement | undefined) => props.onOpenAbout(trigger)
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
        class="relative"
        data-account-trigger=""
        aria-label={updatePending() ? 'User settings, update available' : undefined}
        onPointerEnter={() => props.onIntent?.()}
        onFocus={() => props.onIntent?.()}
      >
        <UserRound aria-hidden="true" />
        <Show when={updatePending()}>
          <span class="global-rail__update-dot" aria-hidden="true" />
        </Show>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // No arrow: Kobalte adds half the arrow height to the gutter, which
        // would push the menu 19px off the button instead of the 4px corner
        // alignment this right-end placement promises.
        hideArrow
        class="min-w-56 max-h-(--kb-popper-available-height) overflow-x-hidden overflow-y-auto"
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
                aria-label={
                  item.id === 'updates' && updatePending() ? 'Updates, update available' : undefined
                }
                onSelect={() => {
                  pendingAfterClose = item.onSelectAfterClose
                    ? { callback: item.onSelectAfterClose }
                    : undefined
                }}
              >
                {item.icon}
                <span>{item.label}</span>
                <Show when={item.id === 'updates' && updatePending()}>
                  <span class="global-rail__update-dot" aria-hidden="true" />
                </Show>
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
