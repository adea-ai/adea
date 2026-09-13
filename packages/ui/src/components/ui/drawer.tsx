import DrawerPrimitive from '@corvu/drawer'
import type { Side } from '@corvu/drawer'
import { Show, splitProps, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'

type DrawerSide = Side

type DrawerProps = ComponentProps<typeof DrawerPrimitive> & {
  /** Base UI spoke of swipe directions; corvu speaks of the side the drawer attaches to. */
  swipeDirection?: DrawerSide
  showSwipeHandle?: boolean
}

// Side drawers honor `--drawer-content-width` (the contract the pre-Solid
// drawer exposed) and fall back to the default width. Task detail sets the
// variable to `min(29rem, 94vw)`; without the variable here the class below
// would win and the panel would render narrower than its committed baseline.
const SIDE_DRAWER_WIDTH = 'w-[var(--drawer-content-width,min(24rem,90vw))]'

const SIDE_CLASSES: Record<DrawerSide, string> = {
  bottom: 'inset-x-0 bottom-0 max-h-[calc(100dvh-2rem)] rounded-t-xl border-t',
  top: 'inset-x-0 top-0 max-h-[calc(100dvh-2rem)] rounded-b-xl border-b',
  left: `inset-y-0 left-0 h-full ${SIDE_DRAWER_WIDTH} rounded-r-xl border-r`,
  right: `inset-y-0 right-0 h-full ${SIDE_DRAWER_WIDTH} rounded-l-xl border-l`,
}

function Drawer(props: DrawerProps) {
  const [local, rest] = splitProps(props, ['swipeDirection', 'side'])
  return (
    <DrawerPrimitive
      data-slot="drawer"
      side={local.side ?? local.swipeDirection ?? 'bottom'}
      {...rest}
    />
  )
}

function DrawerTrigger(props: ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerPortal(props: ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerClose(props: ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

function DrawerOverlay(props: ComponentProps<typeof DrawerPrimitive.Overlay>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      // The scrim keeps the pre-Solid 10% black the committed screenshots
      // were taken against; 25% dimmed the page behind every drawer.
      class={cn(
        'fixed inset-0 z-[110] bg-black/10 backdrop-blur-xs transition-opacity duration-300 data-closed:opacity-0',
        local.class
      )}
      {...rest}
    />
  )
}

function DrawerSwipeHandle(props: ComponentProps<'div'>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <div
      data-slot="drawer-swipe-handle"
      aria-hidden="true"
      class={cn(
        'relative z-10 flex shrink-0 cursor-grab items-center justify-center py-2 active:cursor-grabbing after:block after:h-1 after:w-24 after:shrink-0 after:rounded-full after:bg-muted',
        local.class
      )}
      {...rest}
    />
  )
}

type DrawerContentProps = ComponentProps<typeof DrawerPrimitive.Content> & {
  showSwipeHandle?: boolean
}

function DrawerContent(props: DrawerContentProps) {
  const [local, rest] = splitProps(props, ['class', 'children', 'showSwipeHandle'])
  const side = DrawerPrimitive.useContext().side

  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        class={cn(
          'group/drawer-content fixed z-[110] flex flex-col overflow-hidden bg-popover text-sm text-popover-foreground shadow-lg outline-none transition-transform duration-300 ease-out will-change-transform',
          SIDE_CLASSES[side()],
          local.class
        )}
        {...rest}
      >
        <Show when={local.showSwipeHandle}>
          <DrawerSwipeHandle />
        </Show>
        {local.children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  )
}

function DrawerHeader(props: ComponentProps<'div'>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <div
      data-slot="drawer-header"
      class={cn('flex shrink-0 flex-col gap-0.5 p-4 pb-0 text-center md:text-left', local.class)}
      {...rest}
    />
  )
}

function DrawerFooter(props: ComponentProps<'div'>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <div
      data-slot="drawer-footer"
      class={cn('mt-auto flex shrink-0 flex-col gap-2 p-4 pt-0', local.class)}
      {...rest}
    />
  )
}

function DrawerTitle(props: ComponentProps<typeof DrawerPrimitive.Label>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <DrawerPrimitive.Label
      data-slot="drawer-title"
      class={cn('text-base font-medium text-foreground', local.class)}
      {...rest}
    />
  )
}

function DrawerDescription(props: ComponentProps<typeof DrawerPrimitive.Description>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      class={cn('text-sm text-balance text-muted-foreground', local.class)}
      {...rest}
    />
  )
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerSwipeHandle,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
  type DrawerProps,
}
