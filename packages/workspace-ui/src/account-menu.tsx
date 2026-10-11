import {
  AccountMenu as SharedAccountMenu,
  createAppMenuItems,
  type AccountMenuItem as SharedAccountMenuItem,
} from '@adea-ai/ui/components/composites/account-menu'
import { settingsShortcutLabel } from './keyboard-shortcuts'

type AccountMenuProps = {
  authenticated: boolean
  busy?: boolean
  /** Fires on hover/focus of the trigger — a chance to prefetch menu targets. */
  onIntent?: () => void
  onOpenUpdates?: (opener: HTMLButtonElement | undefined) => void
  onOpenAbout: (opener: HTMLButtonElement | undefined) => void
  onOpenFeedback: (opener: HTMLButtonElement | undefined) => void
  onOpenHelp: (opener: HTMLButtonElement | undefined) => void
  onOpenSettings: (opener: HTMLButtonElement | undefined) => void
  onSignIn: () => void
  onSignOut: () => void
  platform: 'desktop' | 'web'
}

export function AccountMenu(props: AccountMenuProps) {
  const items = (): SharedAccountMenuItem[] =>
    createAppMenuItems({
      primaryItem: { id: 'mobile', label: 'Get the mobile app', disabled: true },
      settingsShortcut: settingsShortcutLabel(),
      onAbout: props.onOpenAbout,
      onHelp: props.onOpenHelp,
      onFeedback: props.onOpenFeedback,
      onUpdates: props.onOpenUpdates,
      onSettings: props.onOpenSettings,
    })

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
