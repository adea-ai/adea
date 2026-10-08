import { BotMessageSquare, CircleUserRound } from 'lucide-solid'
import { createEffect, createSignal, Show } from 'solid-js'
import { ConversationAvatar as SharedConversationAvatar } from '@adea-ai/ui/components/conversation'

/**
 * An agent/user avatar image that falls back to the voice's glyph when the
 * reference is missing or fails to load — the content a conversation avatar
 * carries in Adea, where every speaker may have a remote avatar reference.
 */
export function AvatarContent(props: { avatarRef?: string; kind: 'agent' | 'system' | 'user' }) {
  const [imageFailed, setImageFailed] = createSignal(false)

  createEffect(() => {
    void props.avatarRef
    setImageFailed(false)
  })

  return (
    <Show
      when={props.avatarRef && !imageFailed()}
      fallback={
        props.kind === 'user' ? (
          <CircleUserRound aria-hidden="true" />
        ) : (
          <BotMessageSquare aria-hidden="true" />
        )
      }
    >
      <img
        src={props.avatarRef}
        alt=""
        class="size-full rounded-full object-cover"
        loading="lazy"
        decoding="async"
        fetchpriority="low"
        referrerpolicy="no-referrer"
        onError={() => setImageFailed(true)}
      />
    </Show>
  )
}

export function ConversationAvatar(props: {
  avatarRef?: string
  kind: 'agent' | 'system' | 'user'
}) {
  return (
    <SharedConversationAvatar kind={props.kind}>
      <AvatarContent avatarRef={props.avatarRef} kind={props.kind} />
    </SharedConversationAvatar>
  )
}
