'use client'

import { createPortal } from 'react-dom'
import { useEffect, useState, type ReactNode } from 'react'
import { UserRound } from 'lucide-react'
import { Button } from '#components/ui/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '#components/ui/drawer'
import { ThemeToggle } from './theme-toggle'

export type AccountDrawerProps = {
  accountLabel?: string
  authenticated?: boolean
  busy?: boolean
  musicControl?: ReactNode
  triggerTargetId?: string
  onSignIn?: () => void
  onSignOut?: () => void
}

export function AccountDrawer({
  accountLabel = 'Sign in',
  authenticated = false,
  busy = false,
  musicControl,
  triggerTargetId,
  onSignIn,
  onSignOut,
}: AccountDrawerProps) {
  const [triggerTarget, setTriggerTarget] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setTriggerTarget(triggerTargetId ? document.getElementById(triggerTargetId) : null)
  }, [triggerTargetId])

  const trigger = (
    <DrawerTrigger
      render={
        <Button
          variant="outline"
          size="sm"
          className="workspace-account-trigger"
          aria-label={`Open user menu for ${accountLabel}`}
          aria-haspopup="dialog"
        />
      }
    >
      <UserRound aria-hidden="true" />
      <span>{accountLabel}</span>
    </DrawerTrigger>
  )

  return (
    <Drawer swipeDirection="right">
      {triggerTarget ? (
        createPortal(trigger, triggerTarget)
      ) : (
        <div className="fixed right-4 top-4 z-40">{trigger}</div>
      )}
      <DrawerContent className="w-[min(24rem,90vw)]">
        <DrawerHeader className="border-b px-5 pb-4 pt-5 text-left">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <UserRound className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <DrawerTitle className="truncate">{accountLabel}</DrawerTitle>
                <DrawerDescription>
                  {authenticated
                    ? 'Signed in · workspace saved'
                    : 'Guest workspace · sign in anytime'}
                </DrawerDescription>
              </div>
            </div>
            <ThemeToggle className="shrink-0" />
          </div>
        </DrawerHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
          {musicControl ? (
            <section
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t pt-5"
              aria-labelledby="account-music-title"
            >
              <div className="min-w-0">
                <h2 id="account-music-title" className="text-sm font-semibold">
                  Music
                </h2>
                <p className="text-sm text-muted-foreground">Control the workspace soundtrack.</p>
              </div>
              <div className="flex shrink-0 items-center justify-end">{musicControl}</div>
            </section>
          ) : null}
          <section
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t pt-5"
            aria-labelledby="account-session-title"
          >
            <div className="min-w-0">
              <h2 id="account-session-title" className="text-sm font-semibold">
                Account
              </h2>
              <p className="text-sm text-muted-foreground">
                {authenticated
                  ? 'Sign out on this device without removing your saved workspace.'
                  : 'Sign in or create an account to keep this workspace across devices.'}
              </p>
            </div>
            <DrawerClose
              render={
                <Button
                  type="button"
                  className="shrink-0"
                  variant={authenticated ? 'outline' : 'default'}
                  disabled={busy}
                  onClick={authenticated ? onSignOut : onSignIn}
                />
              }
            >
              {authenticated ? 'Sign out' : 'Sign in'}
            </DrawerClose>
          </section>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
