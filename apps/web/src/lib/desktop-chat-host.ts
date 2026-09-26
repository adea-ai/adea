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

export type DesktopChatLifecycleFence = Readonly<{
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

export function attachFirstRunConversationIfCurrent(
  input: Readonly<{
    created: Pick<ChatConversation, 'runtimeSessionId'>
    currentModel: () => ChatConversationModel | undefined
    lifecycle: DesktopChatLifecycleFence
    model: ChatConversationModel
    onAttached: (conversation: ChatConversation) => void
    request: number
  }>
): void {
  if (!input.lifecycle.isCurrent(input.request)) return
  void input.model.attach(input.created.runtimeSessionId).then((next) => {
    if (!input.lifecycle.isCurrent(input.request) || input.currentModel() !== input.model) return
    input.onAttached(next)
  })
}

/**
 * Binds onboarding creation to the model rendered by the current Solid scope.
 * The model accessor is evaluated while that scope is live; the returned
 * callback only carries the immutable model into deferred work.
 */
export function createFirstRunConversationHandler(
  input: Readonly<{
    getModel: () => ChatConversationModel
    currentModel: () => ChatConversationModel | undefined
    lifecycle: DesktopChatLifecycleFence
    onAttached: (conversation: ChatConversation) => void
    request: number
  }>
): (created: Pick<ChatConversation, 'runtimeSessionId'>) => void {
  const model = input.getModel()
  return (created) => {
    attachFirstRunConversationIfCurrent({
      created,
      currentModel: input.currentModel,
      lifecycle: input.lifecycle,
      model,
      onAttached: input.onAttached,
      request: input.request,
    })
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

  const activate = (scope: Scope): ChatConversationModel => {
    const key = scopeKey(scope)
    if (model && activeKey === key) return model
    activeKey = key
    model = createChatConversationModel(runtime, scope)
    return model
  }

  return {
    get(scope) {
      return activate(scope)
    },
    draftRevision(scope, runtimeSessionId) {
      if (activeKey !== scopeKey(scope)) return 0
      return model?.draftRevision(runtimeSessionId) ?? 0
    },
    setDraft(scope, identity, draft, expectedRevision) {
      if (!model || activeKey !== scopeKey(scope)) return undefined
      return model.setDraftIfCurrent(
        identity.runtimeSessionId,
        identity.generation,
        draft,
        expectedRevision
      )
    },
  }
}
