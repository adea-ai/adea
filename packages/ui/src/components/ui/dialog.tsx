import { Dialog as DialogPrimitive } from '@kobalte/core/dialog'
import { X } from 'lucide-solid'
import { splitProps, type ComponentProps } from 'solid-js'

import { cn } from '#lib/utils'

function Dialog(props: ComponentProps<typeof DialogPrimitive>) {
  // Background inertness is owned by `ModalDialog` (see
  // packages/workspace-ui), which marks the rest of the document `inert` while
  // a dialog is open. Kobalte's own modal layer hides the document with
  // `aria-hidden` and can leave that attribute behind when a dialog closes as
  // a side effect of an async action, which would hide the whole workspace
  // from assistive technology.
  return <DialogPrimitive data-slot="dialog" modal={false} {...props} />
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
      class={cn('fixed inset-0 z-[120] bg-slate-950/55 backdrop-blur-[2px]', local.class)}
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
      {/* Flex centering keeps the dialog on whole pixels; a translate-based
          center can land on a half pixel and shift every edge. */}
      <div class="fixed inset-0 z-[120] flex items-center justify-center p-4">
        <DialogPrimitive.Content
          data-slot="dialog-content"
          class={cn(
            'relative grid max-h-[min(44rem,calc(100dvh-2rem))] w-full max-w-2xl gap-0 overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-2xl outline-none',
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
      </div>
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
