import {
  AccountMenu as SharedAccountMenu,
  createAppMenuItems,
} from '@adea-ai/ui/components/composites/account-menu'

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

/**
 * The rail's account menu: the shared composite with adea's item list and
 * wiring. The trigger is a rail row ("User settings") opening right-end beside
 * the icon, the advertised settings chord follows the running OS, and the
 * pending-update state rides the composite's `updateAvailable` — the updater
 * itself stays here in `update-pending`.
 */
export function AccountMenu(props: AccountMenuProps) {
  return (
    <SharedAccountMenu
      railTrigger
      label="User settings"
      placement="right-end"
      gutter={4}
      hideArrow
      platform={props.platform}
      authenticated={props.authenticated}
      busy={props.busy}
      updateAvailable={updatePending()}
      onIntent={props.onIntent}
      onSignIn={props.onSignIn}
      onSignOut={props.onSignOut}
      items={createAppMenuItems({
        primaryItem: { id: 'mobile', label: 'Get Adea mobile', disabled: true },
        // The advertised chord follows the running OS — the settings binding
        // accepts Meta and Ctrl alike, so Windows and Linux see Ctrl, not ⌘.
        settingsShortcut: settingsShortcutLabel(),
        onAbout: props.onOpenAbout,
        onHelp: props.onOpenHelp,
        onFeedback: props.onOpenFeedback,
        // The shared composite disables an unwired destination, but the local
        // menu kept Updates enabled without a handoff: on a desktop host that
        // has update checking switched off, selecting the row still closes the
        // menu and restores focus (workspace-updates asserts exactly that).
        onUpdates: props.onOpenUpdates ?? (() => undefined),
        onSettings: props.onOpenSettings,
      })}
    />
  )
}
