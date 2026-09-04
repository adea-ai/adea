'use client'

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
} from 'lucide-react'

import { Button } from '@agent-hq/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@agent-hq/ui/components/ui/dropdown-menu'

import { accountMenuItemsForPlatform, accountSessionItem } from './account-menu-model'

type AccountMenuProps = Readonly<{
  authenticated: boolean
  busy?: boolean
  onOpenUpdates?: () => void
  onOpenAbout: () => void
  onOpenSettings: () => void
  onSignIn: () => void
  onSignOut: () => void
  platform: 'desktop' | 'web'
}>

const icons = {
  mobile: Smartphone,
  settings: Settings2,
  about: Info,
  help: CircleHelp,
  feedback: Megaphone,
  updates: RefreshCw,
} as const

export function AccountMenu({
  authenticated,
  busy = false,
  onOpenUpdates,
  onOpenAbout,
  onOpenSettings,
  onSignIn,
  onSignOut,
  platform,
}: AccountMenuProps) {
  const sessionItem = accountSessionItem(authenticated)
  const visibleMenuItems = accountMenuItemsForPlatform(platform)

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            className="global-rail__button global-rail__account-trigger"
            variant="ghost"
            size="icon-lg"
            aria-label="User settings"
          />
        }
      >
        <UserRound aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="global-account-menu" side="top" align="start" sideOffset={0}>
        <DropdownMenuGroup>
          {visibleMenuItems.map((item) => {
            const Icon = icons[item.id]
            const onSelect =
              item.id === 'settings'
                ? onOpenSettings
                : item.id === 'about'
                  ? onOpenAbout
                  : item.id === 'updates'
                    ? onOpenUpdates
                    : undefined
            return (
              <DropdownMenuItem key={item.id} disabled={item.disabled} onClick={onSelect}>
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                {item.id === 'settings' ? (
                  <DropdownMenuShortcut aria-hidden="true">⌘,</DropdownMenuShortcut>
                ) : null}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={busy} onClick={authenticated ? onSignOut : onSignIn}>
            {authenticated ? <LogOut aria-hidden="true" /> : <LogIn aria-hidden="true" />}
            <span>{sessionItem.label}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
