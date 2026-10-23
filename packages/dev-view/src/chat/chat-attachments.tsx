import { createSignal, For, onCleanup, Show, type Accessor, type JSX } from 'solid-js'
import { Attachment, AttachmentList } from '@adea-ai/ui/components/ui/attachment'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Paperclip } from 'lucide-solid'

import {
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_LIMIT_TEXT,
  ATTACHMENT_STORED_TEXT,
  acquireAttachmentTray,
  stageSelection,
  type AttachmentFile,
  type AttachmentIdentity,
  type AttachmentPort,
  type AttachmentTrayView,
} from './model'

/**
 * What the composer needs from a session's attachment tray. The view is a signal so the
 * surface follows the tray rather than anything this component remembers.
 */
export type AttachmentsBinding = Readonly<{
  view: Accessor<AttachmentTrayView>
  /** Why the last chosen file or files could not be attached, in words. */
  notice: Accessor<string | undefined>
  pick(files: readonly AttachmentFile[]): Promise<void>
  retry(id: string): Promise<void>
  remove(id: string): Promise<void>
  dismissNotice(): void
}>

/** A view of this session generation's tray, released with the owner. */
export function createAttachmentsBinding(input: {
  port: AttachmentPort
  identity: AttachmentIdentity
}): AttachmentsBinding {
  const { tray, release } = acquireAttachmentTray(input.port, input.identity)
  const [view, setView] = createSignal<AttachmentTrayView>(tray.view())
  const [notice, setNotice] = createSignal<string | undefined>()
  const unsubscribe = tray.subscribe(setView)
  onCleanup(() => {
    unsubscribe()
    release()
  })
  return {
    view,
    notice,
    async pick(files) {
      setNotice(await stageSelection(tray, files))
    },
    retry: tray.retry,
    remove: tray.remove,
    dismissNotice: () => setNotice(undefined),
  }
}

/** Whether the tray has anything to show above the composer. */
export function attachmentsVisible(binding: AttachmentsBinding | undefined): boolean {
  return (
    binding !== undefined && (binding.view().items.length > 0 || binding.notice() !== undefined)
  )
}

const LIMITS_ID = 'dev-chat-attach-limits'

/**
 * The control that opens the system file chooser. The limits are stated here, before a file is
 * chosen, and again in any refusal.
 */
export function ChatAttachButton(props: {
  binding: AttachmentsBinding
  disabled?: boolean
}): JSX.Element {
  const [picker, setPicker] = createSignal<HTMLInputElement>()
  return (
    <>
      <Input
        ref={setPicker}
        type="file"
        class="sr-only"
        aria-label="Choose text files to attach"
        multiple
        accept={[...ATTACHMENT_EXTENSIONS, 'text/plain'].join(',')}
        data-chat-attach-input=""
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          // Choosing the same file again must fire a change.
          event.currentTarget.value = ''
          if (files.length > 0) void props.binding.pick(files)
        }}
      />
      <ActionButton
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Attach a text file"
        aria-describedby={LIMITS_ID}
        tooltip={`Attach a text file. ${ATTACHMENT_LIMIT_TEXT}`}
        disabled={props.disabled}
        data-chat-attach-button=""
        onClick={() => picker()?.click()}
      >
        <Paperclip aria-hidden="true" />
      </ActionButton>
      <span id={LIMITS_ID} class="sr-only">
        {ATTACHMENT_LIMIT_TEXT}
      </span>
    </>
  )
}

/**
 * The files staged for this conversation, with the host's own words for what is and is not
 * true of them. "Stored" never means "sent": the line under the files says so every time.
 */
export function ChatAttachments(props: { binding: AttachmentsBinding }): JSX.Element {
  const view = props.binding.view
  return (
    <div class="flex flex-col gap-1" data-chat-attachments="">
      <Show when={view().items.length > 0}>
        <AttachmentList aria-label="Attached files">
          <For each={view().items}>
            {(item) => (
              <li class="min-w-0">
                <Attachment
                  name={item.name}
                  kind="text"
                  size={item.byteLength}
                  status={
                    item.state === 'uploading' || item.state === 'removing'
                      ? 'uploading'
                      : item.state === 'stored'
                        ? 'ready'
                        : 'error'
                  }
                  statusLabel={
                    item.state === 'failed'
                      ? 'Not stored'
                      : item.state === 'unconfirmed' || item.state === 'unreconciled'
                        ? 'Not confirmed'
                        : undefined
                  }
                  removeLabel={
                    item.state === 'failed' || item.state === 'unreconciled'
                      ? `Dismiss ${item.name}`
                      : `Remove ${item.name}`
                  }
                  {...(item.state === 'stored' ||
                  item.state === 'failed' ||
                  item.state === 'unreconciled'
                    ? { onRemove: () => void props.binding.remove(item.id) }
                    : {})}
                />
                <Show
                  when={
                    (item.state === 'failed' ||
                      item.state === 'unconfirmed' ||
                      item.state === 'unreconciled') &&
                    item.message
                  }
                >
                  <p class="m-0 px-1 text-xs text-muted-foreground" role="alert">
                    {item.message}
                  </p>
                </Show>
                <Show when={item.state === 'unconfirmed' && item.retryable}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void props.binding.retry(item.id)}
                  >
                    Try again
                  </Button>
                </Show>
                <Show when={item.state === 'stored' && item.message}>
                  <p class="m-0 px-1 text-xs text-muted-foreground" role="alert">
                    {item.message}
                  </p>
                </Show>
              </li>
            )}
          </For>
        </AttachmentList>
        <Show when={view().items.some((item) => item.state === 'stored')}>
          <p
            class="m-0 px-1 text-xs text-muted-foreground"
            role="status"
            data-chat-attachments-status=""
          >
            {ATTACHMENT_STORED_TEXT}
          </p>
        </Show>
      </Show>
      <Show when={props.binding.notice()}>
        {(notice) => (
          <p
            class="m-0 px-1 text-xs text-muted-foreground"
            role="alert"
            data-chat-attach-refusal=""
          >
            {notice()}
          </p>
        )}
      </Show>
    </div>
  )
}
