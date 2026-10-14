import { createEffect, onCleanup } from 'solid-js'
import { invoke, isDesktopRuntime } from './desktop-bridge'

export type ChatPresentationSource = 'chat' | 'dev'

/**
 * Serializes authenticated presentation-only selection hints from the visible
 * Chat/Dev surface. Chat takes precedence while its canonical conversation is
 * mounted; clearing it reveals the selected Dev session again.
 */
export function createChatPresentationReporter(
  send: (focusedSessionId: string | undefined) => void | Promise<void>
) {
  let chatSessionId: string | undefined
  let devSessionId: string | undefined
  let hasLastRequest = false
  let lastRequested: string | undefined
  let pending = Promise.resolve()

  function update(): Promise<void> {
    const focusedSessionId = chatSessionId ?? devSessionId
    if (hasLastRequest && focusedSessionId === lastRequested) return pending
    hasLastRequest = true
    lastRequested = focusedSessionId
    pending = pending
      .then(() => send(focusedSessionId))
      .then(() => undefined)
      .catch(() => {
        // The hint is optional. A later source change can retry, and failure
        // must never interrupt the conversation or Dev surface.
        if (lastRequested === focusedSessionId) hasLastRequest = false
      })
    return pending
  }

  return {
    setChatSession(runtimeSessionId: string | undefined): Promise<void> {
      chatSessionId = runtimeSessionId
      return update()
    },
    setDevSession(runtimeSessionId: string | undefined): Promise<void> {
      devSessionId = runtimeSessionId
      return update()
    },
  }
}

const desktopChatPresentation = createChatPresentationReporter((focusedSessionId) => {
  if (!isDesktopRuntime()) return
  return invoke(
    'desktop_chat_presentation',
    focusedSessionId === undefined ? {} : { focusedSessionId }
  ).then(() => undefined)
})

export function setDesktopChatPresentation(
  source: ChatPresentationSource,
  runtimeSessionId: string | undefined
): Promise<void> {
  return source === 'chat'
    ? desktopChatPresentation.setChatSession(runtimeSessionId)
    : desktopChatPresentation.setDevSession(runtimeSessionId)
}

/** Bind one mounted surface to the shared presentation hint and clear it on disposal. */
export function bindDesktopChatPresentation(
  source: ChatPresentationSource,
  runtimeSessionId: () => string | undefined
): void {
  createEffect(() => {
    void setDesktopChatPresentation(source, runtimeSessionId())
  })
  onCleanup(() => void setDesktopChatPresentation(source, undefined))
}
