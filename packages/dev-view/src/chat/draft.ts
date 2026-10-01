import {
  expandAll,
  findTokenRanges,
  pruneBlocks,
  PASTE_TOKEN_REGEX,
} from '@adea-ai/ui/components/conversation/paste-tokens'

import { ChatRuntimeError, MAX_CHAT_PROMPT_CHARACTERS } from './model/commands'
import type { ChatDraftValue } from './model/types'
import type { Scope } from '@adea-ai/types/dev-runtime'

export { MAX_CHAT_PROMPT_CHARACTERS } from './model/commands'
export type { ChatDraftValue } from './model/types'

export type ChatDraftIdentity = Readonly<{
  runtimeSessionId: string
  generation: number
  scopeKey: string
}>

export function chatDraftScopeKey(scope: Scope): string {
  return `${scope.accountId}\u0000${scope.workspaceId}\u0000${scope.runtimeNodeId}`
}

export type ChatDraftSnapshot = Readonly<{
  identity: ChatDraftIdentity
  hostRevision: number
  localRevision: number
}>

/** Keep visible text and its in-memory paste payload as one canonical value. */
export function normalizeChatDraft(draft: string | ChatDraftValue): ChatDraftValue {
  if (typeof draft === 'string') return { text: draft, blocks: [] }
  const blocks = [...draft.blocks]
  return { text: draft.text, blocks: pruneBlocks(draft.text, blocks) }
}

/** Resolve only complete, backed paste markers before using the existing text transport. */
export function expandChatDraftForSend(draft: ChatDraftValue): string {
  const normalized = normalizeChatDraft(draft)
  const markerRegex = new RegExp(PASTE_TOKEN_REGEX.source, PASTE_TOKEN_REGEX.flags)
  const markerCount = [...normalized.text.matchAll(markerRegex)].length
  const backedMarkerCount = findTokenRanges(normalized.text, normalized.blocks).length
  if (markerCount !== backedMarkerCount)
    throw new ChatRuntimeError({
      code: 'invalid_state',
      retryable: false,
      message: 'pasted content is unavailable. Remove the unresolved paste marker and try again.',
    })

  const prompt = expandAll(normalized.text, normalized.blocks).trim()
  if (prompt.length === 0)
    throw new ChatRuntimeError({
      code: 'invalid_state',
      retryable: false,
      message: 'Chat input cannot be empty after pasted content is expanded.',
    })
  if (prompt.length > MAX_CHAT_PROMPT_CHARACTERS)
    throw new ChatRuntimeError({
      code: 'invalid_state',
      retryable: false,
      message: `Chat prompts must be at most ${MAX_CHAT_PROMPT_CHARACTERS.toLocaleString()} characters after pasted content is expanded.`,
    })
  return prompt
}

function sameSnapshot(left: ChatDraftSnapshot, right: ChatDraftSnapshot): boolean {
  return (
    left.identity.runtimeSessionId === right.identity.runtimeSessionId &&
    left.identity.generation === right.identity.generation &&
    left.identity.scopeKey === right.identity.scopeKey &&
    left.hostRevision === right.hostRevision &&
    left.localRevision === right.localRevision
  )
}

/** Track pending sends by immutable owner identity, not by mounted component. */
export function createChatSendRequests(): Readonly<{
  isPending(key: string): boolean
  begin(key: string): () => void
}> {
  const pending = new Map<string, number>()
  return {
    isPending: (key) => (pending.get(key) ?? 0) > 0,
    begin(key) {
      pending.set(key, (pending.get(key) ?? 0) + 1)
      let finished = false
      return () => {
        if (finished) return
        finished = true
        const count = pending.get(key) ?? 0
        if (count <= 1) pending.delete(key)
        else pending.set(key, count - 1)
      }
    },
  }
}

/** Expand synchronously, deliver that immutable prompt, and clear only its still-current draft. */
export async function submitChatDraftSnapshot(
  input: Readonly<{
    draft: ChatDraftValue
    submitted: ChatDraftSnapshot
    current: () => ChatDraftSnapshot
    deliver: (prompt: string) => void | Promise<void>
    clear: () => void
  }>
): Promise<void> {
  const prompt = expandChatDraftForSend(input.draft)
  await input.deliver(prompt)
  if (sameSnapshot(input.current(), input.submitted)) input.clear()
}
