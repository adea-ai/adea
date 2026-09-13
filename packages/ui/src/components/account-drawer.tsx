import { UserRound } from 'lucide-solid'
import { createEffect, createSignal, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'

import { buttonVariants } from '#components/ui/button'
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
  musicControl?: JSX.Element
  triggerTargetId?: string
  onSignIn?: () => void
  onSignOut?: () => void
}

export function AccountDrawer(props: AccountDrawerProps) {
  const accountLabel = () => props.accountLabel ?? 'Sign in'
  const [triggerTarget, setTriggerTarget] = createSignal<HTMLElement | null>(null)

  createEffect(() =>
    setTriggerTarget(props.triggerTargetId ? document.getElementById(props.triggerTargetId) : null)
  )

  const trigger = (
    <DrawerTrigger
      class={buttonVariants({ variant: 'outline', size: 'sm', class: 'workspace-account-trigger' })}
      aria-label={`Open user menu for ${accountLabel()}`}
      aria-haspopup="dialog"
    >
      <UserRound aria-hidden="true" />
      <span>{accountLabel()}</span>
    </DrawerTrigger>
  )

  return (
    <Drawer swipeDirection="right">
      <Show when={triggerTarget()} fallback={<div class="fixed right-4 top-4 z-40">{trigger}</div>}>
        <Portal mount={triggerTarget()!}>{trigger}</Portal>
      </Show>
      <DrawerContent class="w-[min(24rem,90vw)]">
        <DrawerHeader class="border-b px-5 pb-4 pt-5 text-left">
          <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
            <div class="flex min-w-0 items-center gap-3">
              <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <UserRound class="size-5" aria-hidden="true" />
              </span>
              <div class="min-w-0">
                <DrawerTitle class="truncate">{accountLabel()}</DrawerTitle>
                <DrawerDescription>
                  {props.authenticated
                    ? 'Signed in · workspace saved'
                    : 'Guest workspace · sign in anytime'}
                </DrawerDescription>
              </div>
            </div>
            <ThemeToggle class="shrink-0" />
          </div>
        </DrawerHeader>
        <div class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
          <Show when={props.musicControl}>
            <section
              class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t pt-5"
              aria-labelledby="account-music-title"
            >
              <div class="min-w-0">
                <h2 id="account-music-title" class="text-sm font-semibold">
                  Music
                </h2>
                <p class="text-sm text-muted-foreground">Control the workspace soundtrack.</p>
              </div>
              <div class="flex shrink-0 items-center justify-end">{props.musicControl}</div>
            </section>
          </Show>
          <section
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t pt-5"
            aria-labelledby="account-session-title"
          >
            <div class="min-w-0">
              <h2 id="account-session-title" class="text-sm font-semibold">
                Account
              </h2>
              <p class="text-sm text-muted-foreground">
                {props.authenticated
                  ? 'Sign out on this device without removing your saved workspace.'
                  : 'Sign in or create an account to keep this workspace across devices.'}
              </p>
            </div>
            <DrawerClose
              class={buttonVariants({
                variant: props.authenticated ? 'outline' : 'default',
                class: 'shrink-0',
              })}
              disabled={props.busy}
              onClick={props.authenticated ? props.onSignOut : props.onSignIn}
            >
              {props.authenticated ? 'Sign out' : 'Sign in'}
            </DrawerClose>
          </section>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
