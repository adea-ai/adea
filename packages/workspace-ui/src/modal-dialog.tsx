import { createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@adea-ai/ui/components/ui/dialog'
import { cn } from '@adea-ai/ui/lib/utils'

/**
 * Marks everything outside the dialog `inert` for as long as it is mounted, and
 * restores exactly the elements that did not start out inert. `inert` keeps the
 * background out of the tab order and the accessibility tree without relying on
 * Kobalte's modal layer, whose `aria-hidden` bookkeeping can outlive a dialog
 * that closes as a side effect of an async action.
 */
function useBackgroundInert(open: () => boolean, content: () => HTMLElement | undefined) {
  createEffect(() => {
    if (!open()) return
    const element = content()
    if (!element) return
    const background = [...document.body.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && !child.contains(element)
    )
    const wasInert = background.map((node) => node.hasAttribute('inert'))
    for (const node of background) node.setAttribute('inert', '')
    onCleanup(() => {
      background.forEach((node, index) => {
        if (!wasInert[index]) node.removeAttribute('inert')
      })
    })
  })
}

export function ModalDialog(props: {
  children: JSX.Element
  class?: string
  description?: string
  headerLeading?: JSX.Element
  onClose: () => void
  open: boolean
  title: string
}) {
  // Mount the dialog only while it is open. Kobalte's modal layer hides the
  // rest of the document with `aria-hidden` and restores it on cleanup; an
  // always-mounted dialog that closes as a side effect of an async action can
  // leave that attribute behind, which hides the whole workspace from
  // assistive tech. Unmounting the whole dialog owner makes the cleanup the
  // only way the layer can end.
  const [content, setContent] = createSignal<HTMLElement>()
  useBackgroundInert(() => props.open, content)

  return (
    <Show when={props.open}>
      <Dialog open onOpenChange={(nextOpen) => !nextOpen && props.onClose()}>
        {/* The title element also registers its id for `aria-labelledby`
            through a mount effect; if that registration is ever lost (a
            remount racing its effect under load) the dialog would render
            heading-first but nameless. The explicit label keeps the
            accessible name stable independent of that registration. */}
        <DialogContent
          ref={setContent}
          // ModalDialog forwards the caller's class onto DialogContent by
          // design; the contract flows through.
          // oxlint-disable-next-line shadcn/require-static-classes
          class={cn('conventional-dialog', props.class)}
          aria-label={props.title}
        >
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
    </Show>
  )
}
