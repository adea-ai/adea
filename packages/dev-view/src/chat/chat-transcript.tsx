import { interactionContextDisabledReason } from './model/approval'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type JSX,
} from 'solid-js'
import { Bubble } from '@adea-ai/ui/components/ui/bubble'
import { Button } from '@adea-ai/ui/components/ui/button'
import { CodeBlock } from '@adea-ai/ui/components/ui/code-block'
import { Marker } from '@adea-ai/ui/components/ui/marker'
import {
  Message,
  MessageContent,
  MessageText,
  placeCitationMarkers,
} from '@adea-ai/ui/components/ui/message'
import {
  Questionnaire,
  type QuestionnaireAnswers,
  type QuestionnaireStatus,
} from '@adea-ai/ui/components/ui/questionnaire'
import { Trace, TraceDetail, TraceLine } from '@adea-ai/ui/components/ui/trace'
import { ChatEmpty, ChatNotice } from '@adea-ai/ui/components/composites/chat'
import {
  ChainOfThought,
  ChainOfThoughtStep,
  type ChainOfThoughtStepStatus,
} from '@adea-ai/ui/components/composites/chain-of-thought'
import { messageCitations } from '@adea-ai/ui/components/composites/inline-citation'
import { formatDuration, Reasoning } from '@adea-ai/ui/components/composites/reasoning'
import { Sources, type Source } from '@adea-ai/ui/components/composites/sources'
import { MessageScroller } from '@adea-ai/ui/components/composites/message-scroller'
import type { RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'

import {
  eventRevealRequest,
  registerEventRevealConsumer,
  settleEventReveal,
} from '../history/event-reveal'
import {
  createChatPresentationIdentity,
  type PresentedColumnEntry,
  type PresentedStandaloneEntry,
  type PresentedSegment,
  type PresentedTurn,
} from './model/identity'
import {
  buildChatTurns,
  CHAT_ASSISTANT_TEXT_LIMIT,
  type ChatTurnActivity,
  type ChatTurnApproval,
  type ChatTurnCall,
  type ChatTurnResult,
  type ChatTurnMethod,
  type ChatTurnNotice,
  type ChatTurnQuestion,
  type ChatTurnReasoning,
  type ChatTurnText,
} from './model/turns'
import {
  projectTranscriptEvents,
  type ChatResponseSource,
  type ChatTranscriptItem,
} from './presentation'
import type { TranscriptAccumulator } from './model'
import { transcriptHistoryNotice } from './model/transcript'
import { ChatApproval } from './chat-approval'
import { CallLine } from './chat-calls'
import { ResultLine } from './chat-results'
import { chatTranscriptActionDisabledReason } from './transcript-availability'

export type ChatTranscriptProps = Readonly<{
  events: readonly RuntimeEvent[]
  /** Canonical session and generation scope; never inferred from display content. */
  resetKey: string
  projection?: RuntimeSession['projection']
  transcript?: TranscriptAccumulator
  /**
   * The session's lifecycle says the runtime is working. This is the only thing
   * that draws a "working" line or marks the newest prose as still arriving; no
   * event kind implies it.
   */
  running?: boolean
  /** The host knows a response is outstanding (the runtime is paused on it). */
  awaitingApproval?: boolean
  onResolveApproval?: (
    event: RuntimeEvent,
    resolution: 'approved' | 'denied'
  ) => void | Promise<void>
  onResolveQuestion?: (event: RuntimeEvent, answer: string) => void | Promise<void>
  onJumpToTerminal?: () => void
  /** There are earlier turns the host can load; absent or false draws no control. */
  hasOlder?: boolean
  loadingOlder?: boolean
  /** Load earlier turns; the scroller keeps the reader where they are while they land. */
  onLoadOlder?: () => void | Promise<void>
  /** The last attempt to load earlier turns failed; the control stays so the reader can retry. */
  historyFailed?: boolean
  readingPosition?: Readonly<{ top: number; following: boolean }>
  onReadingPositionChange?: (position: Readonly<{ top: number; following: boolean }>) => void
}>

export {
  CHAT_RESPONSE_UNAVAILABLE_REASON,
  chatTranscriptActionDisabledReason,
} from './transcript-availability'

/** Words for a runtime event kind that stands on a line of its own. */
const KIND_TITLES: Partial<Record<RuntimeEvent['kind'], string>> = {
  'session.created': 'Session created',
  'session.starting': 'Session starting',
  'session.ready': 'Session ready',
  'session.disconnected': 'Session disconnected',
  'session.resumed': 'Session resumed',
  'session.completed': 'Session completed',
  'session.failed': 'Session failed',
  'session.cancelled': 'Session cancelled',
  'capability.degraded': 'Capability degraded',
  'capability.restored': 'Capability restored',
  'turn.result': 'Turn finished',
  'turn.assistant_message': 'Assistant message',
  'turn.assistant_delta': 'Assistant message',
}

function noticeTone(kind: RuntimeEvent['kind']): 'neutral' | 'warning' | 'danger' | 'success' {
  if (kind === 'session.failed') return 'danger'
  if (
    kind === 'session.cancelled' ||
    kind === 'session.disconnected' ||
    kind === 'capability.degraded'
  )
    return 'warning'
  if (kind === 'session.completed' || kind === 'capability.restored') return 'success'
  return 'neutral'
}

function noticeTitle(item: ChatTranscriptItem): string {
  // A payload-supplied name (already bounded and redacted) wins; the wire kind
  // is the fallback, so no event is ever left without words.
  if (item.label !== item.kind) return item.label
  return KIND_TITLES[item.kind] ?? item.kind
}

/** The kind's stated outcome, and nothing a payload hints at. */
function activityStatus(item: ChatTranscriptItem): 'success' | 'error' | undefined {
  if (item.state === 'completed') return 'success'
  if (item.state === 'failed') return 'error'
  return undefined
}

const STATE_WORDS: Record<NonNullable<ChatTranscriptItem['state']>, string> = {
  requested: 'requested',
  started: 'started',
  in_progress: 'progress',
  completed: 'completed',
  failed: 'failed',
  resolved: 'resolved',
  expired: 'expired',
}

function activityTitle(item: ChatTranscriptItem): string {
  if (item.label !== item.kind) return item.label
  if (item.role === 'tool') return 'Tool'
  if (item.role === 'subagent') return 'Subagent'
  return item.kind
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

const PIN_SETTLE_FRAMES = 4
const READER_INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/**
 * Remembers where the first visible entry sits in the scroller. `restore` waits
 * for the scroller's own post-load restore (about two frames), then moves the
 * scroll offset by whatever the entry still drifted, unless the reader acted.
 */
function pinFirstVisibleEntry(scroller: HTMLElement): { restore: () => Promise<void> } | undefined {
  const top = scroller.getBoundingClientRect().top
  const entry = Array.from(scroller.querySelectorAll<HTMLElement>('[data-entry-id]')).find(
    (candidate) => candidate.getBoundingClientRect().bottom > top + 1
  )
  if (!entry) return undefined
  const before = entry.getBoundingClientRect().top - top
  let moved = false
  const note = () => {
    moved = true
  }
  for (const name of READER_INPUTS) scroller.addEventListener(name, note, { passive: true })
  return {
    restore: async () => {
      for (let frame = 0; frame < PIN_SETTLE_FRAMES; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      for (const name of READER_INPUTS) scroller.removeEventListener(name, note)
      if (moved || !entry.isConnected) return
      const drift =
        entry.getBoundingClientRect().top - scroller.getBoundingClientRect().top - before
      if (Math.abs(drift) >= 1) scroller.scrollTop += drift
    },
  }
}

/**
 * What the reader must know before reading any turn: a gap, an older generation,
 * bounded history, a terminal-only projection. They sit outside the scrolling
 * thread (the chat shell's notice row) so they cannot scroll away.
 */
export function ChatTranscriptNotices(
  props: Pick<
    ChatTranscriptProps,
    'transcript' | 'projection' | 'onJumpToTerminal' | 'historyFailed'
  >
): JSX.Element {
  const availability = () => props.transcript?.availability
  const historyNotice = () => {
    const transcript = props.transcript
    return transcript
      ? transcriptHistoryNotice(transcript.retention, transcript.availability)
      : undefined
  }
  return (
    <>
      <Show when={availability()?.status === 'resync_required'}>
        <ChatNotice
          tone="danger"
          live="assertive"
          title="Transcript gap detected. Reconnect to recover the missing runtime events."
        />
      </Show>
      <Show when={availability()?.status === 'stale_generation'}>
        <ChatNotice
          tone="danger"
          live="assertive"
          title="This transcript belongs to an older runtime generation."
        />
      </Show>
      <Show when={props.historyFailed}>
        <ChatNotice
          tone="warning"
          live="polite"
          title="Earlier messages could not be loaded. Try again."
        />
      </Show>
      <Show when={historyNotice()}>
        <ChatNotice tone="info" live="polite" title={historyNotice()!} />
      </Show>
      <Show when={props.projection === 'terminal_fallback'}>
        <ChatNotice
          tone="info"
          live="polite"
          title="Structured events unavailable; showing the terminal transcript projection."
          action={
            <Show when={props.onJumpToTerminal}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => props.onJumpToTerminal?.()}
              >
                Jump to terminal
              </Button>
            </Show>
          }
        />
      </Show>
    </>
  )
}

export function ChatTranscript(props: ChatTranscriptProps): JSX.Element {
  const [answers, setAnswers] = createSignal<Record<string, QuestionnaireAnswers>>({})
  createEffect(
    on(
      () => props.resetKey,
      () => setAnswers({})
    )
  )
  // Memoized, not a plain accessor: the projection walks the whole retained
  // window (up to CHAT_EVENT_RETENTION_LIMIT events) and several readers need it.
  const items = createMemo(() =>
    projectTranscriptEvents(
      props.events,
      props.projection ? { projection: props.projection } : undefined,
      props.transcript
    )
  )
  // One naming memory per session and generation: a new one starts with the
  // scope, so a key never outlives the conversation it named.
  const identity = createMemo(() => {
    void props.resetKey
    return createChatPresentationIdentity()
  })
  const projection = createMemo(() => identity().present(buildChatTurns(items())))
  // Drawn by key, not by object: each event re-projects the window into new
  // objects, but a turn, a segment and a line keep their DOM (and any selection,
  // focus or scroll anchor inside it) while only their content updates. The key
  // is the first name a thing was given, so it also outlives the eviction of the
  // event it was named after.
  const turnIds = createMemo<readonly string[]>(
    () => projection().turns.map((turn) => turn.key),
    [],
    { equals: sameIds }
  )
  const turnById = createMemo(() => new Map(projection().turns.map((turn) => [turn.key, turn])))

  // History asks to show one event. The request waits until this transcript
  // holds the event (a session switch loads it a moment later), then scrolls to
  // its entry and marks it; History gives up on a request nothing answers.
  let thread: HTMLDivElement | undefined
  onCleanup(registerEventRevealConsumer())
  createEffect(() => {
    const request = eventRevealRequest()
    const entryId = request ? projection().entryByEventId.get(request.eventId) : undefined
    if (!request || entryId === undefined) return
    const frame = requestAnimationFrame(() => {
      const target = Array.from(
        thread?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? []
      ).find((candidate) => candidate.dataset.entryId === entryId)
      if (!target) return
      settleEventReveal(request.token)
      target.scrollIntoView({ block: 'center' })
      target.setAttribute('data-revealed', '')
      setTimeout(() => target.removeAttribute('data-revealed'), 2_400)
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

  // Two moments are worth speaking: a response starting and a response ending.
  // Both come from the session lifecycle the host passed, never from prose.
  let wasRunning = props.running === true
  const [announcement, setAnnouncement] = createSignal('')
  createEffect(
    on(
      () => props.running === true,
      (running) => {
        if (running === wasRunning) return
        wasRunning = running
        setAnnouncement(running ? 'Assistant is responding' : 'Response finished')
      },
      { defer: true }
    )
  )
  createEffect(
    on(
      () => props.resetKey,
      () => setAnnouncement('')
    )
  )

  const hasEntries = () => items().length > 0

  // MessageScroller keeps the reader's place by turn. A reply split across
  // history pages stays one turn, so an entry above the reader that changes
  // height inside it (a withheld placeholder becoming the restored text) moves
  // the view with nothing to re-anchor it. Pin the first visible entry by node
  // across the load and put it back once the scroller has restored its own turn;
  // a reader who scrolled meanwhile keeps wherever they went.
  const loadOlderPinned = async () => {
    const load = props.onLoadOlder
    const scroller = thread
    if (!load) return
    const pin = scroller ? pinFirstVisibleEntry(scroller) : undefined
    try {
      await load()
    } finally {
      void pin?.restore()
    }
  }

  return (
    <MessageScroller
      data-dev-chat-stream=""
      aria-label="Conversation transcript"
      resetKey={props.resetKey}
      hasOlder={props.hasOlder}
      loadingOlder={props.loadingOlder}
      onLoadOlder={props.onLoadOlder ? loadOlderPinned : undefined}
      initialReadingPosition={props.readingPosition}
      onReadingPositionChange={props.onReadingPositionChange}
      announcement={announcement()}
      ref={(element: HTMLDivElement) => (thread = element)}
    >
      <Show
        when={hasEntries()}
        fallback={
          <ChatEmpty
            title="No runtime events yet."
            description="Messages and agent activity appear here as the session produces them."
          />
        }
      >
        <For each={turnIds()}>
          {(id) => (
            <Show when={turnById().get(id)}>
              {(turn) => (
                <ChatTurnView
                  turn={() => turnById().get(id) ?? turn()}
                  last={() => turnIds().at(-1) === id}
                  chat={props}
                  answers={answers}
                  setAnswers={setAnswers}
                />
              )}
            </Show>
          )}
        </For>
      </Show>
    </MessageScroller>
  )
}

type TurnViewProps = {
  turn: () => PresentedTurn
  last: () => boolean
  chat: ChatTranscriptProps
  answers: () => Record<string, QuestionnaireAnswers>
  setAnswers: (value: Record<string, QuestionnaireAnswers>) => void
}

function ChatTurnView(props: TurnViewProps): JSX.Element {
  const segments = createMemo(() => props.turn().segments)
  const segmentIds = createMemo<readonly string[]>(
    () => segments().map((segment) => segment.key),
    [],
    { equals: sameIds }
  )
  const segmentById = createMemo(() => new Map(segments().map((segment) => [segment.key, segment])))
  const live = () => props.last() && props.chat.running === true
  const hasReply = () => props.turn().entries.length > 0 || live()

  return (
    <>
      <Show when={props.turn().user}>
        {(user) => (
          <Message
            role="user"
            label="You"
            anchorId={`${props.turn().key}:user`}
            data-entry-id={user().id}
            data-event-id={user().id}
          >
            <Bubble>{user().body ?? user().text ?? user().label}</Bubble>
            <Show when={user().bodyTruncated}>
              <TruncationNote />
            </Show>
          </Message>
        )}
      </Show>
      <Show when={hasReply()}>
        <Message
          role="assistant"
          label="Assistant"
          anchorId={`${props.turn().key}:reply`}
          streaming={live()}
        >
          <MessageContent>
            <For each={segmentIds()}>
              {(id) => (
                <SegmentView
                  segment={() => segmentById().get(id)}
                  lastEntryId={() => props.turn().entries.at(-1)?.id}
                  live={live}
                  chat={props.chat}
                  answers={props.answers}
                  setAnswers={props.setAnswers}
                />
              )}
            </For>
            <Show when={live()}>
              <WorkingLine awaitingApproval={props.chat.awaitingApproval === true} />
            </Show>
          </MessageContent>
        </Message>
      </Show>
    </>
  )
}

type Segment = PresentedSegment

function SegmentView(props: {
  segment: () => Segment | undefined
  lastEntryId: () => string | undefined
  live: () => boolean
  chat: ChatTranscriptProps
  answers: () => Record<string, QuestionnaireAnswers>
  setAnswers: (value: Record<string, QuestionnaireAnswers>) => void
}): JSX.Element {
  const activity = () => {
    const segment = props.segment()
    return segment?.type === 'activity' ? segment.entries : undefined
  }
  const single = () => {
    const segment = props.segment()
    return segment?.type === 'entry' ? segment.entry : undefined
  }
  return (
    <>
      <Show when={activity()}>
        {(entries) => <ActivityColumn entries={entries} live={props.live} />}
      </Show>
      <Show when={single()}>
        {(entry) => (
          <EntryView
            entry={entry()}
            streaming={props.live() && props.lastEntryId() === entry().id}
            chat={props.chat}
            answers={props.answers}
            setAnswers={props.setAnswers}
          />
        )}
      </Show>
    </>
  )
}

function TruncationNote(props: { limit?: number; contextUnavailable?: boolean }): JSX.Element {
  return (
    <Marker
      variant="note"
      tone="warning"
      label={
        props.contextUnavailable
          ? 'Safe response context is unavailable'
          : `Showing the first ${(props.limit ?? CHAT_ASSISTANT_TEXT_LIMIT).toLocaleString('en-US')} characters`
      }
      description={
        props.contextUnavailable
          ? 'This response is hidden because its earlier context is incomplete.'
          : 'The rest of this message is not shown.'
      }
    />
  )
}

function WorkingLine(props: { awaitingApproval: boolean }): JSX.Element {
  return (
    <Trace>
      <Show when={props.awaitingApproval} fallback={<TraceLine title="Working" status="running" />}>
        <TraceLine title="Waiting for a response from you" status="pending" />
      </Show>
    </Trace>
  )
}

function ActivityColumn(props: {
  entries: () => readonly PresentedColumnEntry[]
  live: () => boolean
}): JSX.Element {
  const ids = createMemo<readonly string[]>(() => props.entries().map((entry) => entry.key), [], {
    equals: sameIds,
  })
  const byId = createMemo(() => new Map(props.entries().map((entry) => [entry.key, entry])))
  return (
    <Trace>
      <For each={ids()}>
        {(id) => {
          const entry = () => byId().get(id)
          return (
            <>
              <Show when={entry()?.type === 'activity' ? (entry() as ChatTurnActivity) : undefined}>
                {(activity) => <ActivityLine item={() => byId().get(id) && activity().item} />}
              </Show>
              <Show when={entry()?.type === 'call'}>
                <CallLine entry={() => entry() as ChatTurnCall} live={props.live} />
              </Show>
              <Show when={entry()?.type === 'result'}>
                <ResultLine entry={() => entry() as ChatTurnResult} live={props.live} />
              </Show>
              <Show when={entry()?.type === 'reasoning'}>
                <ReasoningLine entry={() => entry() as ChatTurnReasoning} live={props.live} />
              </Show>
              <Show when={entry()?.type === 'method'}>
                <MethodLine entry={() => entry() as ChatTurnMethod} live={props.live} />
              </Show>
            </>
          )
        }}
      </For>
    </Trace>
  )
}

const isTerminalStatus = (status: string) =>
  status === 'completed' || status === 'failed' || status === 'cancelled'

/**
 * What a source-reported status lets the line say. A `streaming`/`running` status
 * is the producer's last word, not a fact about now: it animates only while the
 * session is working. A turn that stopped mid-stream says it did not finish rather
 * than spinning on forever or claiming a completion nobody reported.
 */
function snapshotWords(
  status: string,
  live: boolean,
  durationMs: number | undefined
): string | undefined {
  const parts: string[] = []
  if (status === 'failed') parts.push('failed')
  else if (status === 'cancelled') parts.push('cancelled')
  else if ((status === 'streaming' || status === 'running') && !live) parts.push('not finished')
  if (isTerminalStatus(status) && durationMs !== undefined)
    parts.push(formatDuration(durationMs / 1000) ?? '')
  const words = parts.filter(Boolean).join(' · ')
  return words.length > 0 ? words : undefined
}

function ReasoningLine(props: {
  entry: () => ChatTurnReasoning
  live: () => boolean
}): JSX.Element {
  const summary = () => props.entry().summary
  const streaming = () => summary().status === 'streaming' && props.live()
  const done = () => isTerminalStatus(summary().status)
  return (
    <Reasoning
      text={summary().text.length > 0 ? summary().text : undefined}
      streaming={streaming()}
      duration={
        done() && summary().durationMs !== undefined ? summary().durationMs! / 1000 : undefined
      }
      meta={
        summary().status === 'failed' || summary().status === 'cancelled' || !streaming()
          ? snapshotWords(
              summary().status,
              props.live(),
              // The title already says "Thought for 4s"; the meta carries only the state.
              undefined
            )
          : undefined
      }
      data-entry-id={props.entry().id}
      data-event-id={props.entry().id}
      data-kind="turn.reasoning_summary"
    />
  )
}

const STEP_STATUS: Partial<Record<string, ChainOfThoughtStepStatus>> = {
  pending: 'pending',
  completed: 'complete',
}

function MethodLine(props: { entry: () => ChatTurnMethod; live: () => boolean }): JSX.Element {
  const stepIds = createMemo<readonly string[]>(
    () => props.entry().steps.map((step) => step.stepId),
    [],
    { equals: sameIds }
  )
  const stepById = createMemo(
    () => new Map(props.entry().steps.map((step) => [step.stepId, step.summary]))
  )
  const count = () => props.entry().steps.length
  return (
    <ChainOfThought
      summary={`${count().toLocaleString('en-US')} method ${count() === 1 ? 'step' : 'steps'}`}
      stepsLabel="Method steps"
      data-entry-id={props.entry().id}
      data-event-id={props.entry().id}
      data-kind="turn.method_step_summary"
    >
      <For each={stepIds()}>
        {(id) => {
          const step = () => stepById().get(id)
          return (
            <Show when={step()}>
              {(summary) => (
                <ChainOfThoughtStep
                  label={summary().title}
                  status={
                    summary().status === 'running'
                      ? props.live()
                        ? 'active'
                        : undefined
                      : STEP_STATUS[summary().status]
                  }
                  meta={snapshotWords(summary().status, props.live(), summary().durationMs)}
                >
                  <Show when={summary().text.length > 0}>
                    <TraceDetail>
                      <MessageText text={summary().text} />
                    </TraceDetail>
                  </Show>
                </ChainOfThoughtStep>
              )}
            </Show>
          )
        }}
      </For>
    </ChainOfThought>
  )
}

/** A result that fits on the line is the line's description; a longer one expands. */
const INLINE_DETAIL_LIMIT = 120

function ActivityLine(props: { item: () => ChatTranscriptItem | undefined }): JSX.Element {
  return (
    <Show when={props.item()}>
      {(item) => {
        const inline = () => {
          const text = item().text
          return text !== undefined && text.length <= INLINE_DETAIL_LIMIT ? text : undefined
        }
        const lineProps = () => ({
          title: activityTitle(item()),
          description: inline(),
          status: activityStatus(item()),
          meta: item().state ? STATE_WORDS[item().state!] : undefined,
          'data-entry-id': item().id,
          'data-event-id': item().id,
          'data-kind': item().kind,
        })
        return (
          <Show
            when={item().output ?? (inline() === undefined ? item().text : undefined)}
            fallback={<TraceLine {...lineProps()} />}
          >
            {(text) => (
              <TraceLine {...lineProps()}>
                <TraceDetail>
                  <CodeBlock code={text()} language="text" size="sm" wrap maxHeight="12rem" />
                </TraceDetail>
              </TraceLine>
            )}
          </Show>
        )
      }}
    </Show>
  )
}

function EntryView(props: {
  entry: PresentedStandaloneEntry
  streaming: boolean
  chat: ChatTranscriptProps
  answers: () => Record<string, QuestionnaireAnswers>
  setAnswers: (value: Record<string, QuestionnaireAnswers>) => void
}): JSX.Element {
  const entry = () => props.entry
  return (
    <>
      <Show when={entry().type === 'text'}>
        <TextEntry entry={entry() as ChatTurnText} streaming={props.streaming} />
      </Show>
      <Show when={entry().type === 'notice'}>
        <NoticeEntry entry={entry() as ChatTurnNotice} />
      </Show>
      <Show when={entry().type === 'approval'}>
        <ChatApproval
          item={(entry() as ChatTurnApproval).item}
          outcome={(entry() as ChatTurnApproval).outcome}
          onResolve={props.chat.onResolveApproval}
          disabledReason={chatTranscriptActionDisabledReason(
            'approval',
            props.chat.onResolveApproval
          )}
        />
      </Show>
      <Show when={entry().type === 'question'}>
        <QuestionEntry
          entry={entry() as ChatTurnQuestion}
          chat={props.chat}
          answers={props.answers}
          setAnswers={props.setAnswers}
        />
      </Show>
    </>
  )
}

function toSource(source: ChatResponseSource): Source {
  return {
    id: source.id,
    title: source.title,
    ...(source.url !== undefined ? { url: source.url } : {}),
    ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
  }
}

function TextEntry(props: { entry: ChatTurnText; streaming: boolean }): JSX.Element {
  const references = () => props.entry.references
  const sources = createMemo(() => references()?.sources.map(toSource) ?? [])
  // The producer's spans become markers only where the shared parser agrees the
  // spot is prose; the displayed text may then differ from `entry.text` by those
  // markers, and nothing else. A message with no references is untouched.
  const placement = createMemo(() => {
    const refs = references()
    if (!refs || refs.citations.length === 0 || sources().length === 0) return undefined
    const numberById = new Map(refs.sources.map((source, index) => [source.id, index + 1]))
    return placeCitationMarkers(
      props.entry.text,
      refs.citations.flatMap((citation) => {
        const number = numberById.get(citation.sourceId)
        return number === undefined ? [] : [{ end: citation.end, numbers: [number] }]
      }),
      sources().length
    )
  })
  const marked = () => (placement() && placement()!.placed > 0 ? placement() : undefined)
  // Count the producer's spans, not marker positions: spans that end together
  // share one marker and are all represented by it.
  const unmarked = () => {
    const refs = references()
    if (!refs) return 0
    const ends = new Set(marked()?.ends ?? [])
    const represented = refs.citations.filter((citation) => ends.has(citation.end)).length
    return refs.cited - represented
  }
  return (
    <div
      class="flex min-w-0 flex-col gap-2 rounded-md data-revealed:bg-primary-subtle"
      data-entry-id={props.entry.id}
      data-event-id={props.entry.id}
      data-source={props.entry.source}
    >
      <MessageText
        text={marked()?.text ?? props.entry.text}
        streaming={props.streaming && props.entry.source === 'delta'}
        codeBlockProps={{ maxHeight: '24rem' }}
        citations={marked() ? messageCitations(sources()) : undefined}
      />
      <Show when={props.entry.truncated}>
        <TruncationNote contextUnavailable={props.entry.text.length === 0} />
      </Show>
      <Show
        when={
          props.entry.source === 'message' &&
          props.entry.text.length === 0 &&
          !props.entry.truncated
        }
      >
        <Marker variant="note" label="The runtime sent an empty message." />
      </Show>
      <Show when={props.entry.failed}>
        <Marker
          variant="note"
          tone="danger"
          label={
            props.entry.summary
              ? `The runtime reported an error for this turn: ${props.entry.summary}`
              : 'The runtime reported an error for this turn.'
          }
        />
      </Show>
      <Show when={sources().length > 0}>
        <Sources sources={sources()} />
        <Show when={unmarked() > 0}>
          <Marker
            variant="note"
            tone="neutral"
            label={`${unmarked().toLocaleString('en-US')} ${unmarked() === 1 ? 'citation is' : 'citations are'} not marked in the text.`}
            description="It falls inside code, or redaction or the display limit changed the text it points at."
          />
        </Show>
      </Show>
    </div>
  )
}

function NoticeEntry(props: { entry: ChatTurnNotice }): JSX.Element {
  const item = () => props.entry.item
  return (
    <div
      class="rounded-md data-revealed:bg-primary-subtle"
      data-entry-id={item().id}
      data-event-id={item().id}
    >
      <Marker
        variant="note"
        tone={noticeTone(item().kind)}
        label={noticeTitle(item())}
        description={item().text}
      />
    </div>
  )
}

const NO_ANSWERS: QuestionnaireAnswers = {}

function QuestionEntry(props: {
  entry: ChatTurnQuestion
  chat: ChatTranscriptProps
  answers: () => Record<string, QuestionnaireAnswers>
  setAnswers: (value: Record<string, QuestionnaireAnswers>) => void
}): JSX.Element {
  const item = () => props.entry.item
  const [status, setStatus] = createSignal<QuestionnaireStatus>('open')
  const [error, setError] = createSignal<string>()
  // Memoised by value: a new projection hands this entry a new item object, and a
  // rebuilt `questions` array would remount the field and lose the draft and focus.
  const prompt = createMemo(
    () =>
      item().requestContext ??
      (item().label !== item().kind ? item().label : 'The runtime is waiting for an answer.')
  )
  const questions = createMemo(() => [
    { id: 'answer', prompt: prompt(), allowText: true, textLabel: 'Answer question' },
  ])
  const disabledReason = () =>
    interactionContextDisabledReason(item()) ??
    chatTranscriptActionDisabledReason('question', props.chat.onResolveQuestion)
  const requested = () => item().state === 'requested' && props.entry.outcome === undefined
  const submit = async (value: QuestionnaireAnswers) => {
    const event = item().event
    const text = value.answer?.text.trim() ?? ''
    if (!event || text.length === 0 || disabledReason()) return
    setStatus('submitting')
    setError(undefined)
    try {
      await props.chat.onResolveQuestion?.(event, text)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The answer could not be sent.')
    } finally {
      // Only a `question.resolved` event is proof the runtime accepted the
      // answer, so the form reopens rather than claiming it was.
      setStatus('open')
    }
  }
  return (
    <Show
      when={requested()}
      fallback={
        <Trace>
          <TraceLine
            title={prompt()}
            meta={
              props.entry.outcome
                ? props.entry.outcome.decision === 'expired'
                  ? STATE_WORDS.expired
                  : 'answered'
                : item().state
                  ? STATE_WORDS[item().state!]
                  : undefined
            }
            status={
              (props.entry.outcome?.decision ?? item().state) === 'expired'
                ? 'cancelled'
                : undefined
            }
            data-entry-id={item().id}
            data-event-id={item().id}
          />
        </Trace>
      }
    >
      <Questionnaire
        data-entry-id={item().id}
        data-event-id={item().id}
        questions={questions()}
        status={status()}
        // Always controlled: `undefined` would let the field keep its own text after a reset.
        answers={props.answers()[item().id] ?? NO_ANSWERS}
        onAnswersChange={(next) => props.setAnswers({ ...props.answers(), [item().id]: next })}
        onSubmit={submit}
        disabledReason={disabledReason()}
        error={error()}
        submitLabel="Submit answer"
      />
    </Show>
  )
}
