import { BotMessageSquare, CircleUserRound } from 'lucide-solid'
import { createEffect, createSignal, Show } from 'solid-js'

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
        loading="lazy"
        decoding="async"
        fetchpriority="low"
        referrerpolicy="no-referrer"
        onError={() => setImageFailed(true)}
      />
    </Show>
  )
}
