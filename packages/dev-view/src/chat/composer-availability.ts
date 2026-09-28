import type { ChatConversation } from './model'
import type { ChatInputAuthority } from './chat-composer'

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
