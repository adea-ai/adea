import { createSignal, onCleanup, Show, type Accessor, type JSX } from 'solid-js'
import { QueueFollowUps } from '@adea-ai/ui/components/composites/queue'
import { Button } from '@adea-ai/ui/components/ui/button'

import {
  canDeliverNext,
  createFollowUpQueueController,
  followUpDeliveryText,
  followUpLastDeliveryText,
  type FollowUpIdentity,
  type FollowUpQueuePort,
  type FollowUpQueueView,
} from './model'

/**
 * What the composer needs from a session's queued-message controller. The view is a signal so
 * the surface follows the host's snapshot rather than anything this component remembers.
 */
export type FollowUpsBinding = Readonly<{
  view: Accessor<FollowUpQueueView>
  enqueue(text: string): Promise<boolean>
  remove(messageId: string): Promise<boolean>
  deliver(): Promise<boolean>
  observeVersion(version: number): void
}>

/**
 * One controller per session generation, disposed with the owner. The first read starts
 * here; until it succeeds the view is `loading` and `unavailable` after a refusal, and
 * neither offers a queue control.
 */
export function createFollowUpsBinding(input: {
  port: FollowUpQueuePort
  identity: FollowUpIdentity
}): FollowUpsBinding {
  const controller = createFollowUpQueueController(input)
  const [view, setView] = createSignal<FollowUpQueueView>(controller.view())
  const unsubscribe = controller.subscribe(setView)
  onCleanup(() => {
    unsubscribe()
    controller.dispose()
  })
  void controller.refresh()
  return {
    view,
    enqueue: controller.enqueue,
    remove: controller.remove,
    deliver: controller.deliver,
    observeVersion: controller.observeVersion,
  }
}

/** Queueing needs a host that answered a read; a loading or refused queue offers no control. */
export function followUpsReady(binding: FollowUpsBinding | undefined): boolean {
  return binding?.view().status === 'ready'
}

/**
 * The messages the person queued and the host has not delivered, with the host's own
 * words for what is and is not happening. A message the host is handing over cannot be
 * withdrawn, so it has no remove control; an unconfirmed one can be removed, which is the
 * only way past it, because it is never sent a second time on our own.
 */
export function ChatFollowUps(props: { binding: FollowUpsBinding }): JSX.Element {
  const view = props.binding.view
  return (
    <Show when={view().status === 'ready' ? view().snapshot : undefined}>
      {(snapshot) => {
        const items = () =>
          snapshot().items.map((item) => ({
            id: item.id,
            text: item.text,
            ...(item.state === 'dispatching' || view().pending
              ? {}
              : { onRemove: () => void props.binding.remove(item.id) }),
          }))
        return (
          <div class="flex flex-col gap-1" data-chat-follow-ups="">
            <QueueFollowUps items={items()} />
            <Show when={snapshot().items.length > 0}>
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground">
                <p class="m-0 min-w-0 flex-1" data-chat-follow-up-status="" role="status">
                  {followUpDeliveryText(snapshot())}
                </p>
                <Show when={canDeliverNext(snapshot())}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={view().pending !== undefined}
                    onClick={() => void props.binding.deliver()}
                  >
                    Send next
                  </Button>
                </Show>
              </div>
            </Show>
            <Show when={followUpLastDeliveryText(snapshot())}>
              {(text) => (
                <p class="m-0 px-1 text-xs text-muted-foreground" data-chat-follow-up-last="">
                  {text()}
                </p>
              )}
            </Show>
            <Show when={view().notice}>
              {(notice) => (
                <p
                  class="m-0 px-1 text-xs text-muted-foreground"
                  role={notice().tone === 'error' ? 'alert' : 'status'}
                >
                  {notice().message}
                </p>
              )}
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
