'use client'

import {
  CircleHelp,
  Info,
  LogIn,
  LogOut,
  Megaphone,
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
  DropdownMenuTrigger,
} from '@agent-hq/ui/components/ui/dropdown-menu'

import { accountMenuItems, accountSessionItem } from './account-menu-model'

type AccountMenuProps = Readonly<{
  authenticated: boolean
  busy?: boolean
  label: string
  onOpenAbout: () => void
  onOpenSettings: () => void
  onSignIn: () => void
  onSignOut: () => void
}>

const icons = {
  mobile: Smartphone,
  settings: Settings2,
  about: Info,
  help: CircleHelp,
  feedback: Megaphone,
} as const

export function AccountMenu({
  authenticated,
  busy = false,
  label,
  onOpenAbout,
  onOpenSettings,
  onSignIn,
  onSignOut,
}: AccountMenuProps) {
  const sessionItem = accountSessionItem(authenticated)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            className="global-rail__button global-rail__account-trigger"
            variant="ghost"
            size="icon-lg"
            aria-label="User settings"
            title={authenticated ? `Account: ${label}` : 'Account: Not signed in'}
          />
        }
      >
        <UserRound aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="global-account-menu" side="right" align="end" sideOffset={8}>
        <DropdownMenuGroup>
          {accountMenuItems.map((item) => {
            const Icon = icons[item.id]
            const onSelect =
              item.id === 'settings'
                ? onOpenSettings
                : item.id === 'about'
                  ? onOpenAbout
                  : undefined
            return (
              <DropdownMenuItem key={item.id} disabled={item.disabled} onClick={onSelect}>
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
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
