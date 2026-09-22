import { createSignal, Show, type JSX } from 'solid-js'

import type { ChatConversation } from './model'

export type ChatInputAuthority = 'chat' | 'dev' | 'none'

export type ChatComposerProps = Readonly<{
  conversation: ChatConversation
  authority?: ChatInputAuthority
  connected?: boolean
  awaitingApproval?: boolean
  busy?: boolean
  onSend?: (text: string) => void | Promise<void>
  onSteer?: (text: string) => void | Promise<void>
  onStop?: () => void | Promise<void>
}>

export function chatComposerDisabledReason(props: {
  conversation: ChatConversation
  authority: ChatInputAuthority
  connected: boolean
  awaitingApproval: boolean
}): string | undefined {
  if (props.conversation.archived) return 'This conversation is archived.'
  if (!['active', 'ready'].includes(props.conversation.status))
    return `Chat is unavailable while the runtime is ${props.conversation.status}.`
  if (props.authority !== 'chat') return 'Chat input is owned by the active runtime.'
  if (props.awaitingApproval) return 'Waiting for approval before sending input.'
  if (!props.connected) return 'Runtime disconnected. Reconnect the transcript to continue.'
  return undefined
}

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const [draft, setDraft] = createSignal(props.conversation.draft)
  const [sending, setSending] = createSignal(false)
  const authority = () => props.authority ?? 'chat'
  const connected = () => props.connected ?? true
  const disabledReason = () =>
    chatComposerDisabledReason({
      conversation: props.conversation,
      authority: authority(),
      connected: connected(),
      awaitingApproval: props.awaitingApproval ?? false,
    })
  const disabled = () => disabledReason() !== undefined || sending()
  const submit = async (mode: 'send' | 'steer', event: Event) => {
    event.preventDefault()
    const text = draft().trim()
    if (disabled() || text.length === 0) return
    setSending(true)
    try {
      if (mode === 'steer') await props.onSteer?.(text)
      else await props.onSend?.(text)
      setDraft('')
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      class="dev-chat__composer"
      aria-label="Chat composer"
      onSubmit={(event) => submit('send', event)}
    >
      <label for="dev-chat-composer-input">Message runtime</label>
      <textarea
        id="dev-chat-composer-input"
        value={draft()}
        disabled={disabled()}
        aria-describedby="dev-chat-composer-status"
        placeholder="Send a message to the runtime"
        onInput={(event) => setDraft(event.currentTarget.value)}
      />
      <p id="dev-chat-composer-status" role="status">
        <Show when={disabledReason()} fallback="Input is sent with the current runtime generation.">
          {(reason) => reason()}
        </Show>
      </p>
      <div class="dev-chat__composer-actions">
        <Show when={props.busy}>
          <button type="button" class="dev-button" onClick={() => props.onStop?.()}>
            Stop
          </button>
          <button
            type="button"
            class="dev-button"
            disabled={disabled()}
            onClick={(event) => void submit('steer', event)}
          >
            Steer
          </button>
        </Show>
        <button type="submit" class="dev-button" disabled={disabled()}>
          {sending() ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  )
}
