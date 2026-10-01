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
  const items = (): SharedAccountMenuItem[] =>
    accountMenuItemsForPlatform(props.platform).map((item) => ({
      id: item.id,
      label: item.label,
      disabled: item.disabled,
      shortcut: item.id === 'settings' ? '⌘,' : undefined,
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
      class="global-rail__account-trigger self-center"
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
