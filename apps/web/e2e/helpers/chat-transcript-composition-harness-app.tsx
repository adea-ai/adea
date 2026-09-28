import '../../src/start/globals.css'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { ChatTranscript } from '@adea-ai/dev-view/chat'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

function event(id: string, kind: RuntimeEvent['kind'], text: string): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: id,
    runtimeSessionId: 'session-1',
    generation: 1,
    seq: id === 'question-1' ? '2' : '1',
    occurredAt: '2026-09-27T00:00:00Z',
    receivedAt: '2026-09-27T00:00:00Z',
    source: 'host',
    sourceEventId: id,
    confidence: 'authoritative',
    classification: 'workspace_private',
    kind,
    payload: { text, callId: 'opaque', interactive: false, conclusion: true },
  }
}

const question = event('question-1', 'question.requested', 'Which target?')
const [events, setEvents] = createSignal<readonly RuntimeEvent[]>([question])
const [resetKey, setResetKey] = createSignal('session-1:1')

window.chatTranscriptCompositionHarness = {
  prepend: () => setEvents([event('tool-1', 'tool.completed', 'Opaque tool result'), question]),
  reset: () => setResetKey('session-1:2'),
}

render(
  () => <ChatTranscript events={events()} resetKey={resetKey()} />,
  document.querySelector('#harness-root')!
)

declare global {
  interface Window {
    chatTranscriptCompositionHarness: { prepend(): void; reset(): void }
  }
}
