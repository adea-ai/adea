import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'

import {
  bindDesktopChatPresentation,
  type ChatPresentationSource,
} from '../../src/lib/desktop-chat-presentation'

// This small harness tests the reporter hook's source precedence and cleanup.
// Production caller wiring is exercised separately by WorkspaceNavigation's
// mounted browser regression.
type PresentationSurfaceProps = Readonly<{
  source: ChatPresentationSource
  runtimeSessionId: () => string | undefined
}>

function PresentationSurface(props: PresentationSurfaceProps) {
  bindDesktopChatPresentation(props.source, props.runtimeSessionId)
  return null
}

const calls: Array<{ command: string; sessionId: string | null }> = []
window.__adeaDesktop = {
  invoke: async (command, args) => {
    calls.push({
      command,
      sessionId: typeof args?.focusedSessionId === 'string' ? args.focusedSessionId : null,
    })
    return null
  },
  listen: async () => () => undefined,
}

const [chatMounted, setChatMounted] = createSignal(true)
const [devMounted, setDevMounted] = createSignal(true)
const [chatSessionId, setChatSessionId] = createSignal<string>()
const [devSessionId] = createSignal('dev-1')
const root = document.getElementById('harness-root')
if (!root) throw new Error('presentation harness root missing')

render(
  () => (
    <>
      <Show when={devMounted()}>
        <PresentationSurface source="dev" runtimeSessionId={() => devSessionId()} />
      </Show>
      <Show when={chatMounted()}>
        <PresentationSurface source="chat" runtimeSessionId={() => chatSessionId()} />
      </Show>
    </>
  ),
  root
)

window.desktopChatPresentationHarness = {
  setChatSession: setChatSessionId,
  unmountChat: () => setChatMounted(false),
  unmountDev: () => setDevMounted(false),
  report: () => [...calls],
}

declare global {
  interface Window {
    desktopChatPresentationHarness: {
      setChatSession(runtimeSessionId: string | undefined): void
      unmountChat(): void
      unmountDev(): void
      report(): Array<{ command: string; sessionId: string | null }>
    }
  }
}
