import { Show, type JSX } from 'solid-js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@adea-ai/ui/components/ui/dialog'
import { cn } from '@adea-ai/ui/lib/utils'

export function ModalDialog(props: {
  children: JSX.Element
  class?: string
  description?: string
  headerLeading?: JSX.Element
  onClose: () => void
  open: boolean
  title: string
}) {
  return (
    <Dialog open={props.open} onOpenChange={(nextOpen) => !nextOpen && props.onClose()}>
      <DialogContent class={cn('conventional-dialog', props.class)}>
        <DialogHeader class="conventional-dialog__header">
          <Show
            when={props.headerLeading}
            fallback={
              <>
                <DialogTitle>{props.title}</DialogTitle>
                <Show when={props.description}>
                  {(description) => <DialogDescription>{description()}</DialogDescription>}
                </Show>
              </>
            }
          >
            {(headerLeading) => (
              <div class="conventional-dialog__heading">
                {headerLeading()}
                <div>
                  <DialogTitle>{props.title}</DialogTitle>
                  <Show when={props.description}>
                    {(description) => <DialogDescription>{description()}</DialogDescription>}
                  </Show>
                </div>
              </div>
            )}
          </Show>
        </DialogHeader>
        {props.children}
      </DialogContent>
    </Dialog>
  )
}
