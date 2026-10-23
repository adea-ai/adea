import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'
import { createMemo, createSignal, For, onCleanup, onMount } from 'solid-js'
import { ChatView } from './chat-view'
import type { ChatDraftChange } from './chat-composer'
import {
  acceptRuntimeEvent,
  acceptRuntimeStreamFrame,
  createTranscriptAccumulator,
} from './model/transcript'
import { createRuntimeHistoryLoader } from './model/history'
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
  resultEvents,
  resultEdgeEvents,
  historyNewest,
  historyOlder,
  historySplitEnd,
  historySplitMiddle,
  historySplitPrompt,
  historySplitStart,
  historySplitTail,
  retentionTurnScript,
  richEvents,
} from './visual-fixture-data'
import {
  createFixtureAttachments,
  FIXTURE_ATTACHMENT_MODES,
  createFixtureCheckpointRestore,
  createFixtureFollowUpHost,
  type FixtureAttachmentMode,
  type FixtureFollowUpMode,
} from './visual-fixture-follow-ups'
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
  /** Structured results: terminal output, a failing test run with a stack, files, a plan and a task. */
  | 'results'
  /** Results that must not say more than the producer did, in a session that has stopped. */
  | 'results-edge'
  /** One earlier turn that loads when asked. */
  | 'history'
  /** The same, but the first request for it fails and the second succeeds. */
  | 'history-retry'
  /** The same, but every request fails. */
  | 'history-offline'
  /** One reply whose start is two history pages back; the real loader restores it. */
  | 'history-split'
  /** A live stream the test can close, with or without the host refusing its position. */
  | 'stream-close'
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
  results: resultEvents,
  'results-edge': resultEdgeEvents,
  history: historyNewest,
  'history-retry': historyNewest,
  'history-offline': historyNewest,
  'history-split': [historySplitEnd, historySplitTail],
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
          : state === 'cancelled' || state === 'grounded-stopped' || state === 'results-edge'
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
 * A stream that holds one earlier turn back until the reader asks for it. With `failFirst`
 * the first request rejects (the turn stays unloaded and retryable) and the second lands it.
 */
function historyModel(
  mode: 'ok' | 'fail-first' | 'offline'
): Pick<ChatConversationModel, 'openTranscript' | 'send' | 'cancel'> {
  return {
    openTranscript: async () => {
      let state: TranscriptAccumulator = {
        runtimeSessionId: sessionId,
        generation: 3,
        fromSequence: '3',
        events: historyNewest,
        availability: { status: 'available' },
        retention: { maxEvents: 1_000, oldestSequence: '3', newestSequence: '4', complete: false },
      }
      let older = true
      let attempts = 0
      const listeners = new Set<(state: TranscriptAccumulator) => void>()
      return {
        state: () => state,
        subscribe: (listener: (state: TranscriptAccumulator) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        hasOlder: () => older,
        loadOlder: async () => {
          attempts += 1
          ;(window as unknown as { chatHistoryAttempts?: number }).chatHistoryAttempts = attempts
          await new Promise((resolve) => setTimeout(resolve, 50))
          if (mode === 'offline' || (mode === 'fail-first' && attempts === 1))
            throw new Error('offline')
          older = false
          state = {
            ...state,
            events: [...historyOlder, ...state.events],
            retention: { ...state.retention, oldestSequence: '1', complete: true },
          }
          for (const listener of listeners) listener(state)
        },
        close: () => listeners.clear(),
      }
    },
    send: async () => undefined,
    cancel: async () => conversation('streaming', historyNewest),
  }
}

const splitHistoryPage = (before: string, items: readonly RuntimeEvent[], more: boolean) => ({
  runtimeSessionId: sessionId,
  generation: 3,
  beforeSequence: before,
  retainedFromSequence: '1',
  retainedThroughSequence: before,
  historyStart: 'generation_start' as const,
  items,
  ...(more ? { nextCursor: 'older' } : {}),
})

/**
 * The real accumulator and history loader over a reply that straddles the pages: the
 * window on screen holds only its last delta, so nothing of it may be drawn until the
 * pages that restore its start have loaded. Each request is counted for the test.
 */
function splitHistoryModel(): Pick<ChatConversationModel, 'openTranscript' | 'send' | 'cancel'> {
  return {
    openTranscript: async () => {
      let state: TranscriptAccumulator = acceptRuntimeEvent(
        acceptRuntimeEvent(
          createTranscriptAccumulator({
            runtimeSessionId: sessionId,
            generation: 3,
            fromSequence: '4',
          }),
          historySplitEnd
        ),
        historySplitTail
      )
      const listeners = new Set<(state: TranscriptAccumulator) => void>()
      let attempts = 0
      const loader = createRuntimeHistoryLoader({
        state: () => state,
        commit: (next) => {
          state = next
          for (const listener of listeners) listener(state)
        },
        read: async (request) => {
          attempts += 1
          ;(window as unknown as { chatHistoryAttempts?: number }).chatHistoryAttempts = attempts
          await new Promise((resolve) => setTimeout(resolve, 50))
          return 'cursor' in request
            ? splitHistoryPage('3', [historySplitPrompt, historySplitStart], false)
            : splitHistoryPage('4', [historySplitMiddle], true)
        },
      })
      // The test loads the earlier pages itself, from wherever the reader is scrolled to.
      const loadOlder = () => void loader.loadOlder().catch(() => undefined)
      window.addEventListener('chat-visual:load-older', loadOlder)
      return {
        state: () => state,
        subscribe: (listener: (state: TranscriptAccumulator) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        hasOlder: loader.hasOlder,
        loadOlder: loader.loadOlder,
        close: () => {
          window.removeEventListener('chat-visual:load-older', loadOlder)
          loader.close()
          listeners.clear()
        },
      }
    },
    send: async () => undefined,
    cancel: async () => conversation('streaming', [historySplitEnd, historySplitTail]),
  }
}

/**
 * A live stream that ends when told to: `chat-visual:close` carries the close code and,
 * optionally, the error code the host sent before it. Every open records the position it
 * asked for, so a test can see what a reconnect requests.
 */
function closableModel(): Pick<ChatConversationModel, 'openTranscript' | 'send' | 'cancel'> {
  return {
    openTranscript: async (_runtimeSessionId, options) => {
      const opens = ((window as unknown as { chatStreamOpens?: string[] }).chatStreamOpens ??= [])
      opens.push(options?.fromSequence ?? '')
      // `chatStreamScript` scripts the next opens: `fail` rejects, `closed` returns a handle
      // that ended before anyone subscribed, `refused` one the host ended by refusing the cursor.
      const script = (window as unknown as { chatStreamScript?: string[] }).chatStreamScript
      const step = script?.shift() ?? 'ok'
      if (step === 'fail') throw new Error('Runtime stream unavailable.')
      let state = createTranscriptAccumulator({ runtimeSessionId: sessionId, generation: 3 })
      for (const item of transcriptEvents) state = acceptRuntimeEvent(state, item)
      const listeners = new Set<(state: TranscriptAccumulator) => void>()
      const end = (detail: { code: string; error?: string }) => {
        if (detail.error !== undefined)
          state = acceptRuntimeStreamFrame(
            state,
            {
              type: 'error',
              error: {
                code: detail.error,
                message: 'The host refused the stream.',
                retryable: false,
              },
            } as never,
            'native'
          )
        state = acceptRuntimeStreamFrame(
          state,
          { type: 'close', code: detail.code } as never,
          'native'
        )
        for (const listener of listeners) listener(state)
      }
      const onClose = (closeEvent: Event) =>
        end((closeEvent as CustomEvent<{ code: string; error?: string }>).detail)
      if (step === 'closed') end({ code: 'normal' })
      if (step === 'refused') end({ code: 'incompatible', error: 'sequence_gap' })
      window.addEventListener('chat-visual:close', onClose)
      return {
        state: () => state,
        subscribe: (listener: (state: TranscriptAccumulator) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        close: () => {
          listeners.clear()
          window.removeEventListener('chat-visual:close', onClose)
        },
      }
    },
    send: async () => undefined,
    cancel: async () => conversation('streaming', transcriptEvents),
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
  // `chatRestore=ok|fail` marks the fixture checkpoint restorable and stands up a stand-in for the
  // host's restore; without it the checkpoint is the marker the host reported (restore unavailable).
  const restoreMode = new URLSearchParams(window.location.search).get('chatRestore')
  const baseEvents =
    state === 'attention' ? attentionEvents : (STATE_EVENTS[state] ?? transcriptEvents)
  const events =
    restoreMode === 'ok' || restoreMode === 'fail'
      ? baseEvents.map((item) =>
          item.kind === 'checkpoint.observed'
            ? {
                ...item,
                payload: { ...(item.payload as object), restore: { supported: true } },
              }
            : item
        )
      : baseEvents
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
                : state === 'stream-close'
                  ? closableModel()
                  : state === 'history-split'
                    ? splitHistoryModel()
                    : state === 'history' ||
                        state === 'history-retry' ||
                        state === 'history-offline'
                      ? historyModel(
                          state === 'history'
                            ? 'ok'
                            : state === 'history-retry'
                              ? 'fail-first'
                              : 'offline'
                        )
                      : undefined
  const [draft, setDraft] = createSignal<ChatDraftValue>({
    text: state === 'attention' ? 'I can clarify the target environment.' : '',
    blocks: [],
  })
  const [draftRevision, setDraftRevision] = createSignal(0)
  const [generation, setGeneration] = createSignal(3)
  const [mountKey, setMountKey] = createSignal(0)
  // Another conversation is selected: the same view, a different session (A -> B -> A).
  const [away, setAway] = createSignal(false)
  const [cancelCount, setCancelCount] = createSignal(0)
  const [resolution, setResolution] = createSignal('')
  const [readingPosition, setReadingPosition] =
    createSignal<Readonly<{ top: number; following: boolean }>>()
  const deferred = new URLSearchParams(window.location.search).has('chatDraftTest')
  const fallbackDraftModel = new URLSearchParams(window.location.search).has('chatDraftFallback')
  const pending: Set<PendingSend> = new Set()
  // `chatQueue=busy|ready|ambiguous|unavailable` stands up a stand-in for the host's follow-up queue.
  const queueMode = new URLSearchParams(window.location.search).get('chatQueue')
  const followUps = ['busy', 'ready', 'ambiguous', 'unavailable'].includes(queueMode ?? '')
    ? createFixtureFollowUpHost(queueMode as FixtureFollowUpMode)
    : undefined
  // `chatAttach=<mode>` stands up a stand-in for the host's attachment store (see
  // `FIXTURE_ATTACHMENT_MODES`).
  const attachMode = new URLSearchParams(window.location.search).get('chatAttach')
  const attachments = FIXTURE_ATTACHMENT_MODES.includes(attachMode as FixtureAttachmentMode)
    ? createFixtureAttachments(attachMode as FixtureAttachmentMode)
    : undefined
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
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const switchSession = (selection: Event) => {
      setAway((selection as CustomEvent<{ away: boolean }>).detail.away)
      setMountKey((key) => key + 1)
    }
    window.addEventListener('chat-visual:remount', remount)
    window.addEventListener('chat-visual:switch-session', switchSession)
    window.addEventListener('chat-visual:next-generation', nextGeneration)
    window.addEventListener('chat-visual:resolve-send', resolveSend)
    window.addEventListener('chat-visual:reject-send', rejectSend)
    onCleanup(() => {
      window.removeEventListener('chat-visual:remount', remount)
      window.removeEventListener('chat-visual:switch-session', switchSession)
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
      data-chat-away={away() ? '' : undefined}
      data-chat-draft={draft().text}
      data-chat-cancel-count={cancelCount()}
      data-chat-resolution={resolution()}
    >
      <div class="dev-chat-visual-fixture__stage">
        <For each={[mountKey()]}>
          {() => {
            return (
              <ChatView
                conversation={
                  away()
                    ? { ...activeConversation(), runtimeSessionId: `${sessionId}-other` }
                    : activeConversation()
                }
                model={currentModel}
                authority="chat"
                // The closable stream reports its own state; every other fixture is simply connected.
                connected={state === 'stream-close' ? undefined : state !== 'reconnect'}
                awaitingApproval={state === 'attention' || state === 'rich'}
                handoff={
                  new URLSearchParams(window.location.search).has('chatHandoff') ? {} : undefined
                }
                followUps={followUps}
                attachments={attachments}
                checkpointRestore={
                  restoreMode === 'ok' || restoreMode === 'fail'
                    ? createFixtureCheckpointRestore(restoreMode)
                    : undefined
                }
                onCheckpointRestored={({ restoredGeneration }) => {
                  setGeneration(restoredGeneration)
                  setMountKey((key) => key + 1)
                }}
                usageModel={
                  state === 'results-edge'
                    ? { providerId: 'anthropic', modelId: 'fixture-model' }
                    : undefined
                }
                autoAttach={
                  state === 'reconnect' ||
                  state === 'streaming' ||
                  state === 'code-stream' ||
                  state === 'grounded-stream' ||
                  state === 'retention-turn' ||
                  state === 'retention-stream' ||
                  state === 'history' ||
                  state === 'history-retry' ||
                  state === 'history-offline' ||
                  state === 'history-split' ||
                  state === 'stream-close'
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
