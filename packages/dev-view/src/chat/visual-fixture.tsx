import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'
import { ChatView } from './chat-view'
import type { ChatConversation, ChatConversationModel, TranscriptAccumulator } from './model'
import './visual-fixture.css'

export type ChatVisualFixtureState = 'conversation' | 'attention' | 'reconnect' | 'streaming'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

const sessionId = '00000000-0000-4000-8000-000000000004'

function event(
  seq: string,
  kind: RuntimeEvent['kind'],
  payload: unknown,
  eventId = `chat-visual-${seq}`
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId,
    runtimeSessionId: sessionId,
    generation: 3,
    seq,
    occurredAt: '2026-09-22T10:00:00.000Z',
    receivedAt: '2026-09-22T10:00:00.000Z',
    source: 'native',
    sourceEventId: eventId,
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind,
    payload,
  }
}

const transcriptEvents: readonly RuntimeEvent[] = [
  event('1', 'turn.user_input', { text: 'Review the deployment plan and summarize the risks.' }),
  event('2', 'tool.started', { name: 'workspace.search', text: 'Searching the project notes…' }),
  event('3', 'tool.completed', { name: 'workspace.search', summary: 'Found 4 relevant notes.' }),
  event(
    '4',
    'turn.assistant_delta',
    { text: 'The plan is ready. I found two risks worth addressing before approval.' },
    'chat-visual-stream'
  ),
  event('5', 'turn.assistant_message', {
    text: 'The plan is ready. I found two risks worth addressing before approval.',
  }),
]

const attentionEvents: readonly RuntimeEvent[] = [
  ...transcriptEvents,
  event('6', 'approval.requested', {
    name: 'Apply migration plan',
    text: 'The runtime is waiting for approval to apply the reviewed changes.',
  }),
  event('7', 'question.requested', {
    name: 'Target environment',
    question: 'Which environment should receive the reviewed changes?',
  }),
]

function conversation(
  state: ChatVisualFixtureState,
  events: readonly RuntimeEvent[]
): ChatConversation {
  return {
    runtimeSessionId: sessionId,
    scope,
    projectId: '00000000-0000-4000-8000-000000000005',
    repoId: '00000000-0000-4000-8000-000000000006',
    worktreeId: '00000000-0000-4000-8000-000000000007',
    groupIds: ['00000000-0000-4000-8000-000000000008'],
    title:
      state === 'attention'
        ? 'Approval and question review'
        : state === 'reconnect'
          ? 'Reconnect required'
          : 'Deployment plan review',
    status: state === 'reconnect' ? 'disconnected' : 'active',
    archived: false,
    projection: 'structured',
    generation: 3,
    version: 4,
    activeHarnessRunId: '00000000-0000-4000-8000-000000000009',
    draft: state === 'attention' ? 'I can clarify the target environment.' : '',
    events,
    retention: {
      maxEvents: 1_000,
      oldestSequence: events[0]?.seq ?? '0',
      newestSequence: events.at(-1)?.seq ?? '0',
      complete: true,
    },
  }
}

function reconnectModel(): Pick<ChatConversationModel, 'openTranscript' | 'send' | 'cancel'> {
  return {
    openTranscript: async () => {
      const state: TranscriptAccumulator = {
        runtimeSessionId: sessionId,
        generation: 3,
        fromSequence: '5',
        events: transcriptEvents,
        availability: {
          status: 'resync_required',
          reason: 'sequence_gap',
          expectedSequence: '6',
          receivedSequence: '8',
        },
        retention: {
          maxEvents: 1_000,
          oldestSequence: '1',
          newestSequence: '5',
          complete: false,
          reason: 'sequence_gap',
        },
      }
      return {
        state: () => state,
        subscribe: () => () => undefined,
        close: () => undefined,
      }
    },
    send: async () => undefined,
    cancel: async () => conversation('reconnect', transcriptEvents),
  }
}

function streamingModel(): Pick<ChatConversationModel, 'openTranscript' | 'send' | 'cancel'> {
  return {
    openTranscript: async () => {
      let state: TranscriptAccumulator = {
        runtimeSessionId: sessionId,
        generation: 3,
        fromSequence: '5',
        events: transcriptEvents,
        availability: { status: 'available' },
        retention: {
          maxEvents: 1_000,
          oldestSequence: '1',
          newestSequence: '5',
          complete: true,
        },
      }
      // Streaming is spec-driven, not timer-driven: each `chat-visual:append`
      // window event appends exactly one canonical event, so an E2E run can
      // prove row stability without racing a wall clock.
      const streamTexts = ['A later stream update arrived.', 'Streaming continues to append rows.']
      let nextSeq = 6
      const append = () => {
        const text = streamTexts[nextSeq - 6]
        if (text === undefined) return
        const next = event(String(nextSeq), 'turn.assistant_delta', { text })
        nextSeq += 1
        state = {
          ...state,
          events: [...state.events, next],
          retention: { ...state.retention, newestSequence: next.seq },
        }
      }
      const listeners = new Set<(state: TranscriptAccumulator) => void>()
      const onAppend = () => {
        append()
        for (const listener of listeners) listener(state)
      }
      window.addEventListener('chat-visual:append', onAppend)
      return {
        state: () => state,
        subscribe: (listener: (state: TranscriptAccumulator) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        close: () => {
          listeners.clear()
          window.removeEventListener('chat-visual:append', onAppend)
        },
      }
    },
    send: async () => undefined,
    cancel: async () => conversation('streaming', transcriptEvents),
  }
}

export function ChatVisualFixture(props: Readonly<{ state?: ChatVisualFixtureState }>) {
  const state = props.state ?? 'conversation'
  const events = state === 'attention' ? attentionEvents : transcriptEvents
  const model =
    state === 'reconnect' ? reconnectModel() : state === 'streaming' ? streamingModel() : undefined
  return (
    <main class="dev-chat-visual-fixture" data-chat-visual-state={state}>
      <div class="dev-chat-visual-fixture__stage">
        <ChatView
          conversation={conversation(state, events)}
          {...(model ? { model } : {})}
          authority="chat"
          connected={state !== 'reconnect'}
          awaitingApproval={state === 'attention'}
          autoAttach={state === 'reconnect' || state === 'streaming'}
          onResolveApproval={() => undefined}
          onResolveQuestion={() => undefined}
        />
      </div>
    </main>
  )
}
