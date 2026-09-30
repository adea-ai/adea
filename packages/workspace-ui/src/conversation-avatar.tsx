import { BotMessageSquare, CircleUserRound } from 'lucide-solid'
import { createEffect, createSignal, Show } from 'solid-js'
import { ConversationAvatar as SharedConversationAvatar } from '@adea-ai/ui/components/conversation'

export function ConversationAvatar(props: {
  avatarRef?: string
  kind: 'agent' | 'system' | 'user'
}) {
  const [imageFailed, setImageFailed] = createSignal(false)

  createEffect(() => {
    void props.avatarRef
    setImageFailed(false)
  })

  return (
    <SharedConversationAvatar kind={props.kind}>
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
    </SharedConversationAvatar>
  )
}
