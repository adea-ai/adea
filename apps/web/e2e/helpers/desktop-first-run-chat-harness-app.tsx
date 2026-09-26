import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'

import {
  FirstRunOnboarding,
  type FirstRunFacts,
  type FirstRunConversation,
} from '@adea-ai/dev-view/chat'
import type { ChatConversation, ChatConversationModel } from '@adea-ai/dev-view/chat/model'

import {
  attachFirstRunConversationIfCurrent,
  createDesktopChatLifecycleFence,
} from '../../src/lib/desktop-chat-host'

const facts: FirstRunFacts = {
  identity: 'signed_in',
  managedPi: { state: 'ready' },
  modelAccess: 'provisioned',
  projectReady: true,
  agentProfileReady: true,
}

function createModel(label: string) {
  let attachCalls = 0
  const model = {
    attach: async () => {
      attachCalls += 1
      return new Promise<ChatConversation>(() => undefined)
    },
  } as unknown as ChatConversationModel

  return {
    model,
    report: () => ({ attachCalls, label }),
  }
}

function mount() {
  const root = document.getElementById('harness-root')
  if (!root) throw new Error('harness root missing')

  const lifecycle = createDesktopChatLifecycleFence()
  const old = createModel('old')
  const next = createModel('next')
  let conversationCallbacks = 0
  let lateStateReadFailures = 0
  const [ready, setReady] = createSignal<{ facts: FirstRunFacts; model: ChatConversationModel }>({
    facts,
    model: old.model,
  })
  let resolveCreate: ((conversation: FirstRunConversation) => void) | undefined

  const port = {
    installManagedPi: async () => ({ state: 'ready' as const }),
    createConversation: async () =>
      new Promise<FirstRunConversation>((resolve) => {
        resolveCreate = resolve
      }),
  }

  render(
    () => (
      <Show when={ready()} fallback={<p data-testid="disposed-fallback">disposed</p>}>
        {(rawState) => {
          const state = () => {
            try {
              return rawState()
            } catch (error) {
              lateStateReadFailures += 1
              throw error
            }
          }
          const request = lifecycle.current()
          const boundModel = state().model
          return (
            <FirstRunOnboarding
              facts={state().facts}
              port={port}
              onAction={() => undefined}
              onConversation={(created) => {
                conversationCallbacks += 1
                attachFirstRunConversationIfCurrent({
                  created,
                  currentModel: () => ready()?.model,
                  lifecycle,
                  model: boundModel,
                  onAttached: () => undefined,
                  request,
                })
              }}
            />
          )
        }}
      </Show>
    ),
    root
  )

  window.desktopFirstRunChatHarness = {
    replaceScope: () => {
      setReady(undefined)
      lifecycle.begin()
    },
    restoreNextScope: () => setReady({ facts, model: next.model }),
    resolveOldCreate: () => {
      if (!resolveCreate) return false
      resolveCreate({ runtimeSessionId: 'old-runtime-session' } as FirstRunConversation)
      return true
    },
    report: () => ({
      old: old.report(),
      next: next.report(),
      conversationCallbacks,
      lateStateReadFailures,
    }),
  }
}

declare global {
  interface Window {
    desktopFirstRunChatHarness: {
      replaceScope(): void
      restoreNextScope(): void
      resolveOldCreate(): boolean
      report(): {
        old: { attachCalls: number; label: string }
        next: { attachCalls: number; label: string }
        conversationCallbacks: number
        lateStateReadFailures: number
      }
    }
  }
}

mount()
