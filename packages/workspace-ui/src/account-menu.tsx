import {
  AccountMenu as SharedAccountMenu,
  type AccountMenuItem as SharedAccountMenuItem,
} from '@adea-ai/ui/components/composites/account-menu'

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

export function AccountMenu(props: AccountMenuProps) {
  // No `shortcut` here: the shared menu item appends the chord glyph into the
  // item's accessible name, so a `⌘,` hint turns "Settings" into
  // "Settings ⌘," — which is not a chord a screen reader can parse. The
  // app-local menu this replaced kept the same hint in an aria-hidden
  // `DropdownMenuShortcut`. Until the shared item aria-hides its glyph (as
  // SideRailItem already does) or accepts `aria-keyshortcuts`, omitting the
  // glyph is what keeps the accessible name correct.
  const items = (): SharedAccountMenuItem[] =>
    accountMenuItemsForPlatform(props.platform).map((item) => ({
      id: item.id,
      label: item.label,
      disabled: item.disabled,
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

  return (
    <SharedAccountMenu
      authenticated={props.authenticated}
      busy={props.busy}
      class="global-rail__button global-rail__account-trigger"
      items={items()}
      label="User settings"
      onIntent={props.onIntent}
      onSignIn={props.onSignIn}
      onSignOut={props.onSignOut}
      platform={props.platform}
      size="icon-lg"
    />
  )
}
