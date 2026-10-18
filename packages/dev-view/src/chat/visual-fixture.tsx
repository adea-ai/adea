import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'
import { createMemo, createSignal, For, onCleanup, onMount } from 'solid-js'
import { ChatView } from './chat-view'
import type { ChatDraftChange } from './chat-composer'
import { acceptRuntimeEvent, createTranscriptAccumulator } from './model/transcript'
import type {
  ChatConversation,
  ChatConversationModel,
  ChatDraftValue,
  TranscriptAccumulator,
} from './model'
import {
  callEvents,
  cancelledEvents,
  codeStreamTexts,
  copyEvents,
  failedEvents,
  FIXTURE_SESSION_ID,
  fixtureEvent,
  groundedEvents,
  groundedHostileEvents,
  groundedPrompt,
  groundedScript,
  groundedStoppedEvents,
  hostileEvents,
  largeEvents,
  longApprovalEvents,
  retentionStreamEvents,
  retentionStreamScript,
  retentionTurnEvents,
  retentionTurnScript,
  richEvents,
} from './visual-fixture-data'
import './visual-fixture.css'

export type ChatVisualFixtureState =
  | 'conversation'
  | 'attention'
  | 'reconnect'
  | 'streaming'
  /** A new conversation: no events yet. */
  | 'empty'
  /** A realistic multi-turn session: tools, a failing run, prose with code, a pending approval and question. */
  | 'rich'
  /** Untrusted text: markup, hostile links, secrets, a huge token, an unknown event kind. */
  | 'hostile'
  | 'failed'
  | 'cancelled'
  /** A code fence that opens in one streamed fragment and closes in a later one. */
  | 'code-stream'
  /** Output past every bound: a 2,500-line block and prose longer than a message may be. */
  | 'large'
  /** A code block whose exact whitespace a copy must preserve. */
  | 'copy'
  /** Source-reported reasoning and method summaries and a cited answer, settled. */
  | 'grounded'
  /** The same, one scripted event per `chat-visual:append`. */
  | 'grounded-stream'
  /** The producer's last word was streaming and the session then stopped. */
  | 'grounded-stopped'
  /** Untrusted text in every summary and reference field. */
  | 'grounded-hostile'
  /** Tool and subagent calls with producer identity: nested, failed, running and orphaned. */
  | 'calls'
  /** An approval whose request is longer than the card's description shows. */
  | 'approval-long'
  /** The real accumulator, one event per `chat-visual:append` (or `detail.count`): a turn whose prompt is evicted. */
  | 'retention-turn'
  /** The same, for one reply streamed in deltas far past the window. */
  | 'retention-stream'

const codeStreamInitial: readonly RuntimeEvent[] = [
  fixtureEvent('1', 'turn.user_input', { text: 'Add a helper.' }),
]

const STATE_EVENTS: Partial<Record<ChatVisualFixtureState, readonly RuntimeEvent[]>> = {
  empty: [],
  rich: richEvents,
  hostile: hostileEvents,
  failed: failedEvents,
  cancelled: cancelledEvents,
  'code-stream': codeStreamInitial,
  large: largeEvents,
  copy: copyEvents,
  grounded: groundedEvents,
  'grounded-stream': [groundedPrompt],
  'grounded-stopped': groundedStoppedEvents,
  'grounded-hostile': groundedHostileEvents,
  'approval-long': longApprovalEvents,
  calls: callEvents,
  'retention-turn': retentionTurnEvents,
  'retention-stream': retentionStreamEvents,
}

const STATE_TITLES: Partial<Record<ChatVisualFixtureState, string>> = {
  attention: 'Approval and question review',
  reconnect: 'Reconnect required',
  empty: 'New conversation',
  rich: 'Migration review',
  hostile: 'Untrusted content',
  failed: 'Verification run',
  cancelled: 'Release notes draft',
}

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

const sessionId = FIXTURE_SESSION_ID
const event = fixtureEvent

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
  events: readonly RuntimeEvent[],
  draft = state === 'attention' ? 'I can clarify the target environment.' : '',
  generation = 3,
  draftBlocks: ChatDraftValue['blocks'] = []
): ChatConversation {
  return {
    runtimeSessionId: sessionId,
    scope,
    projectId: '00000000-0000-4000-8000-000000000005',
    repoId: '00000000-0000-4000-8000-000000000006',
    worktreeId: '00000000-0000-4000-8000-000000000007',
    title: STATE_TITLES[state] ?? 'Deployment plan review',
    status:
      state === 'reconnect'
        ? 'disconnected'
        : state === 'failed'
          ? 'failed'
          : state === 'cancelled' || state === 'grounded-stopped'
            ? 'cancelled'
            : state === 'empty' || state === 'grounded' || state === 'grounded-hostile'
              ? 'ready'
              : 'active',
    archived: false,
    projection: 'structured',
    generation,
    version: 4,
    activeHarnessRunId: '00000000-0000-4000-8000-000000000009',
    draft,
    draftBlocks,
    events: events.map((item) => ({ ...item, generation })),
    retention: {
      maxEvents: 1_000,
      oldestSequence: events[0]?.seq ?? '0',
      newestSequence: events.at(-1)?.seq ?? '0',
      complete: true,
    },
  }
}

type PendingSend = Readonly<{
  resolve: () => void
  reject: (error: Error) => void
}>

function draftModel(
  getConversation: () => ChatConversation,
  onCancel: () => void,
  pending: Set<PendingSend>,
  deferred: boolean,
  getDraftRevision: () => number,
  setCanonicalDraft: (draft: string | ChatDraftValue) => void
): Pick<
  ChatConversationModel,
  | 'openTranscript'
  | 'send'
  | 'cancel'
  | 'draftRevision'
  | 'setDraftIfCurrent'
  | 'createPasteBlockId'
> {
  let nextPasteBlockId = 0
  return {
    openTranscript: async () => {
      throw new Error('visual draft fixture does not attach a transcript')
    },
    send: async () => {
      if (!deferred) return
      await new Promise<void>((resolve, reject) => {
        pending.add({ resolve, reject })
      })
    },
    cancel: async () => {
      onCancel()
      return getConversation()
    },
    draftRevision: () => getDraftRevision(),
    createPasteBlockId: () => `visual-chat-paste-${++nextPasteBlockId}`,
    setDraftIfCurrent: (runtimeSessionId, generation, nextDraft, expectedRevision) => {
      const current = getConversation()
      if (
        current.runtimeSessionId !== runtimeSessionId ||
        current.generation !== generation ||
        (expectedRevision !== undefined && expectedRevision !== getDraftRevision())
      )
        return undefined
      setCanonicalDraft(nextDraft)
      return current
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

function streamingModel(
  initial: readonly RuntimeEvent[] = transcriptEvents,
  streamTexts: readonly (string | ((seq: string) => RuntimeEvent))[] = [
    'A later stream update arrived.',
    'Streaming continues to append rows.',
  ],
  onCancel: () => void = () => undefined
): Pick<ChatConversationModel, 'openTranscript' | 'send' | 'cancel'> {
  return {
    openTranscript: async () => {
      let state: TranscriptAccumulator = {
        runtimeSessionId: sessionId,
        generation: 3,
        fromSequence: '5',
        events: initial,
        availability: { status: 'available' },
        retention: {
          maxEvents: 1_000,
          oldestSequence: '1',
          newestSequence: initial.at(-1)?.seq ?? '0',
          complete: true,
        },
      }
      // Streaming is spec-driven, not timer-driven: each `chat-visual:append`
      // window event appends exactly one canonical event, so an E2E run can
      // prove row stability without racing a wall clock.
      const firstSeq = Number(initial.at(-1)?.seq ?? '0') + 1
      let nextSeq = firstSeq
      const append = () => {
        const step = streamTexts[nextSeq - firstSeq]
        if (step === undefined) return
        const next =
          typeof step === 'function'
            ? step(String(nextSeq))
            : event(String(nextSeq), 'turn.assistant_delta', { text: step })
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
    cancel: async () => {
      onCancel()
      return conversation('streaming', initial)
    },
  }
}

/**
 * A transcript fed through the real accumulator, so the window fills and drops
 * its oldest event exactly as a live session's does. Each `chat-visual:append`
 * adds `detail.count` events (default one) and tells the subscriber once.
 */
function retainingModel(
  initial: readonly RuntimeEvent[],
  script: (seq: string) => RuntimeEvent
): Pick<ChatConversationModel, 'openTranscript' | 'send' | 'cancel'> {
  return {
    openTranscript: async () => {
      let state = createTranscriptAccumulator({ runtimeSessionId: sessionId, generation: 3 })
      for (const item of initial) state = acceptRuntimeEvent(state, item)
      let nextSeq = Number(initial.at(-1)?.seq ?? '0') + 1
      const listeners = new Set<(state: TranscriptAccumulator) => void>()
      const onAppend = (appendEvent: Event) => {
        const count = (appendEvent as CustomEvent<{ count?: number }>).detail?.count ?? 1
        for (let n = 0; n < count; n += 1) {
          state = acceptRuntimeEvent(state, script(String(nextSeq)))
          nextSeq += 1
        }
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
    cancel: async () => conversation('streaming', retentionTurnEvents),
  }
}

export function ChatVisualFixture(props: Readonly<{ state?: ChatVisualFixtureState }>) {
  const state = props.state ?? 'conversation'
  const events = state === 'attention' ? attentionEvents : (STATE_EVENTS[state] ?? transcriptEvents)
  const model =
    state === 'reconnect'
      ? reconnectModel()
      : state === 'streaming'
        ? streamingModel(undefined, undefined, () => setCancelCount((count) => count + 1))
        : state === 'code-stream'
          ? streamingModel(codeStreamInitial, codeStreamTexts, () =>
              setCancelCount((count) => count + 1)
            )
          : state === 'grounded-stream'
            ? streamingModel([groundedPrompt], groundedScript, () =>
                setCancelCount((count) => count + 1)
              )
            : state === 'retention-turn'
              ? retainingModel(retentionTurnEvents, retentionTurnScript)
              : state === 'retention-stream'
                ? retainingModel(retentionStreamEvents, retentionStreamScript)
                : undefined
  const [draft, setDraft] = createSignal<ChatDraftValue>({
    text: state === 'attention' ? 'I can clarify the target environment.' : '',
    blocks: [],
  })
  const [draftRevision, setDraftRevision] = createSignal(0)
  const [generation, setGeneration] = createSignal(3)
  const [mountKey, setMountKey] = createSignal(0)
  const [cancelCount, setCancelCount] = createSignal(0)
  const [resolution, setResolution] = createSignal('')
  const [readingPosition, setReadingPosition] =
    createSignal<Readonly<{ top: number; following: boolean }>>()
  const deferred = new URLSearchParams(window.location.search).has('chatDraftTest')
  const fallbackDraftModel = new URLSearchParams(window.location.search).has('chatDraftFallback')
  const pending: Set<PendingSend> = new Set()
  const activeConversation = createMemo(() =>
    conversation(state, events, draft().text, generation(), draft().blocks)
  )

  const resolvePending = (error?: Error) => {
    const next = pending.values().next().value as PendingSend | undefined
    if (!next) return
    pending.delete(next)
    if (error) next.reject(error)
    else next.resolve()
  }

  onMount(() => {
    // Captures this component's signals and pending-send state.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const remount = () => setMountKey((key) => key + 1)
    // Captures this component's signals and pending-send state.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const nextGeneration = () => {
      setGeneration((value) => value + 1)
      setMountKey((key) => key + 1)
    }
    // Captures this component's signals and pending-send state.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const resolveSend = () => resolvePending()
    // Captures this component's signals and pending-send state.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const rejectSend = () => resolvePending(new Error('visual send failed'))
    window.addEventListener('chat-visual:remount', remount)
    window.addEventListener('chat-visual:next-generation', nextGeneration)
    window.addEventListener('chat-visual:resolve-send', resolveSend)
    window.addEventListener('chat-visual:reject-send', rejectSend)
    onCleanup(() => {
      window.removeEventListener('chat-visual:remount', remount)
      window.removeEventListener('chat-visual:next-generation', nextGeneration)
      window.removeEventListener('chat-visual:resolve-send', resolveSend)
      window.removeEventListener('chat-visual:reject-send', rejectSend)
      for (const send of pending) send.reject(new Error('visual fixture unmounted'))
      pending.clear()
    })
  })

  const currentModel =
    model ??
    draftModel(
      activeConversation,
      () => setCancelCount((count) => count + 1),
      pending,
      deferred,
      () => draftRevision(),
      (nextDraft) => {
        const normalized =
          typeof nextDraft === 'string' ? { text: nextDraft, blocks: [] } : nextDraft
        setDraft(normalized)
        setDraftRevision((revision) => revision + 1)
      }
    )
  const onDraftChange: ChatDraftChange | undefined = fallbackDraftModel
    ? undefined
    : (next, identity, expectedRevision) => {
        if (identity.runtimeSessionId !== sessionId || identity.generation !== generation()) return
        if (expectedRevision !== undefined && expectedRevision !== draftRevision()) return
        setDraft(next)
        setDraftRevision((revision) => revision + 1)
      }
  return (
    <main
      class="dev-chat-visual-fixture"
      data-chat-visual-state={state}
      data-chat-session-id={sessionId}
      data-chat-generation={generation()}
      data-chat-draft={draft().text}
      data-chat-cancel-count={cancelCount()}
      data-chat-resolution={resolution()}
    >
      <div class="dev-chat-visual-fixture__stage">
        <For each={[mountKey()]}>
          {() => {
            return (
              <ChatView
                conversation={activeConversation()}
                model={currentModel}
                authority="chat"
                connected={state !== 'reconnect'}
                awaitingApproval={state === 'attention' || state === 'rich'}
                autoAttach={
                  state === 'reconnect' ||
                  state === 'streaming' ||
                  state === 'code-stream' ||
                  state === 'grounded-stream' ||
                  state === 'retention-turn' ||
                  state === 'retention-stream'
                }
                draftRevision={fallbackDraftModel ? undefined : draftRevision()}
                onDraftChange={onDraftChange}
                readingPosition={readingPosition()}
                onReadingPositionChange={(_, position) => setReadingPosition(position)}
                onResolveApproval={(approval, choice) => {
                  setResolution(JSON.stringify({ eventId: approval.eventId, choice }))
                }}
                onResolveQuestion={(question, answer) => {
                  setResolution(JSON.stringify({ eventId: question.eventId, answer }))
                }}
              />
            )
          }}
        </For>
      </div>
    </main>
  )
}
