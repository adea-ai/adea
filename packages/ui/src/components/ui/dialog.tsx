import { Dialog as DialogPrimitive } from '@kobalte/core/dialog'
import { X } from 'lucide-solid'
import { splitProps, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'

function Dialog(props: ComponentProps<typeof DialogPrimitive>) {
  return <DialogPrimitive data-slot="dialog" {...props} />
}

function DialogTrigger(props: ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal(props: ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose(props: ComponentProps<typeof DialogPrimitive.CloseButton>) {
  return <DialogPrimitive.CloseButton data-slot="dialog-close" {...props} />
}

function DialogOverlay(props: ComponentProps<typeof DialogPrimitive.Overlay>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      class={cn(
        'fixed inset-0 z-[120] bg-slate-950/55 backdrop-blur-[2px] data-closed:animate-out data-closed:fade-out-0 data-expanded:animate-in data-expanded:fade-in-0',
        local.class
      )}
      {...rest}
    />
  )
}

function DialogContent(
  props: ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }
) {
  const [local, rest] = splitProps(props, ['class', 'children', 'showCloseButton'])
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        class={cn(
          'fixed top-1/2 left-1/2 z-[120] grid max-h-[min(44rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 gap-0 overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-2xl outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-expanded:animate-in data-expanded:fade-in-0 data-expanded:zoom-in-95',
          local.class
        )}
        {...rest}
      >
        {local.children}
        {(local.showCloseButton ?? true) ? (
          <DialogPrimitive.CloseButton
            data-slot="dialog-close"
            class="absolute right-4 top-4 inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label="Close dialog"
          >
            <X class="size-4" aria-hidden="true" />
          </DialogPrimitive.CloseButton>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader(props: ComponentProps<'div'>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <div
      data-slot="dialog-header"
      class={cn('flex flex-col gap-1.5 border-b px-6 py-5 pr-14', local.class)}
      {...rest}
    />
  )
}

function DialogFooter(props: ComponentProps<'div'>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <div
      data-slot="dialog-footer"
      class={cn(
        'flex flex-col-reverse gap-2 border-t px-6 py-4 sm:flex-row sm:justify-end',
        local.class
      )}
      {...rest}
    />
  )
}

function DialogTitle(props: ComponentProps<typeof DialogPrimitive.Title>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      class={cn('text-base font-semibold tracking-tight', local.class)}
      {...rest}
    />
  )
}

function DialogDescription(props: ComponentProps<typeof DialogPrimitive.Description>) {
  const [local, rest] = splitProps(props, ['class'])
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      class={cn('text-sm leading-5 text-muted-foreground', local.class)}
      {...rest}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
