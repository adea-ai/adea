import { createChatConversationModel } from '@adea-ai/dev-view/chat/model'
import type { ChatConversation, ChatConversationModel } from '@adea-ai/dev-view/chat/model'
import type { Scope } from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'

export type DesktopChatDraftIdentity = Readonly<{
  runtimeSessionId: string
  generation: number
}>

export type DesktopChatModelHost = Readonly<{
  get(scope: Scope): ChatConversationModel
  draftRevision(scope: Scope, runtimeSessionId: string): number
  setDraft(
    scope: Scope,
    identity: DesktopChatDraftIdentity,
    draft: string,
    expectedRevision?: number
  ): ChatConversation | undefined
}>

type DesktopChatLifecycleFence = Readonly<{
  begin(): number
  current(): number
  invalidate(): void
  isCurrent(token: number): boolean
}>

/**
 * Keeps async onboarding/attach continuations tied to the current mounted
 * host. A cleanup or newer load invalidates every older continuation.
 */
export function createDesktopChatLifecycleFence(): DesktopChatLifecycleFence {
  let token = 0
  return {
    begin: () => {
      token += 1
      return token
    },
    current: () => token,
    invalidate: () => {
      token += 1
    },
    isCurrent: (candidate) => candidate === token,
  }
}

function scopeKey(scope: Scope): string {
  return `${scope.accountId}\u0000${scope.workspaceId}\u0000${scope.runtimeNodeId}`
}

/**
 * Owns the runtime Chat model at the desktop workspace boundary. The cache is
 * instance-scoped, holds only the current authenticated runtime scope, and is
 * therefore shared by Chat remounts without becoming a process-global store.
 */
export function createDesktopChatModelHost(runtime: DevRuntimeService): DesktopChatModelHost {
  let activeKey: string | undefined
  let model: ChatConversationModel | undefined
  const revisions = new Map<string, number>()

  const activate = (scope: Scope): ChatConversationModel => {
    const key = scopeKey(scope)
    if (model && activeKey === key) return model
    activeKey = key
    revisions.clear()
    model = createChatConversationModel(runtime, scope)
    return model
  }

  return {
    get(scope) {
      return activate(scope)
    },
    draftRevision(scope, runtimeSessionId) {
      if (activeKey !== scopeKey(scope)) return 0
      return revisions.get(runtimeSessionId) ?? 0
    },
    setDraft(scope, identity, draft, expectedRevision) {
      if (!model || activeKey !== scopeKey(scope)) return undefined
      const current = model
        .project()
        .conversations.find(
          (conversation) =>
            conversation.runtimeSessionId === identity.runtimeSessionId &&
            conversation.generation === identity.generation
        )
      if (!current) return undefined
      const revision = revisions.get(identity.runtimeSessionId) ?? 0
      if (expectedRevision !== undefined && expectedRevision !== revision) return undefined
      const next = model.setDraft(identity.runtimeSessionId, draft)
      revisions.set(identity.runtimeSessionId, revision + 1)
      return next
    },
  }
}
