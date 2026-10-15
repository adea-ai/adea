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
import { Message, MessageContent, MessageText } from '@adea-ai/ui/components/ui/message'
import {
  Questionnaire,
  type QuestionnaireAnswers,
  type QuestionnaireStatus,
} from '@adea-ai/ui/components/ui/questionnaire'
import { Trace, TraceDetail, TraceLine } from '@adea-ai/ui/components/ui/trace'
import { ChatEmpty, ChatNotice } from '@adea-ai/ui/components/composites/chat'
import { MessageScroller } from '@adea-ai/ui/components/composites/message-scroller'
import type { RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'

import {
  eventRevealRequest,
  registerEventRevealConsumer,
  settleEventReveal,
} from '../history/event-reveal'
import {
  buildChatTurns,
  CHAT_ASSISTANT_TEXT_LIMIT,
  segmentTurnEntries,
  type ChatTurn,
  type ChatTurnActivity,
  type ChatTurnApproval,
  type ChatTurnEntry,
  type ChatTurnNotice,
  type ChatTurnQuestion,
  type ChatTurnText,
} from './model/turns'
import { projectTranscriptEvents, type ChatTranscriptItem } from './presentation'
import type { TranscriptAccumulator } from './model'
import { transcriptHistoryNotice } from './model/transcript'
import { ChatApproval } from './chat-approval'
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

/**
 * What the reader must know before reading any turn: a gap, an older generation,
 * bounded history, a terminal-only projection. They sit outside the scrolling
 * thread (the chat shell's notice row) so they cannot scroll away.
 */
export function ChatTranscriptNotices(
  props: Pick<ChatTranscriptProps, 'transcript' | 'projection' | 'onJumpToTerminal'>
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
      props.projection ? { projection: props.projection } : undefined
    )
  )
  const projection = createMemo(() => buildChatTurns(items()))
  // Drawn by id, not by object: each event re-projects the window into new
  // objects, but a turn, a segment and a line keep their DOM (and any selection,
  // focus or scroll anchor inside it) while only their content updates.
  const turnIds = createMemo<readonly string[]>(
    () => projection().turns.map((turn) => turn.id),
    [],
    { equals: sameIds }
  )
  const turnById = createMemo(() => new Map(projection().turns.map((turn) => [turn.id, turn])))

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

  return (
    <MessageScroller
      data-dev-chat-stream=""
      aria-label="Conversation transcript"
      resetKey={props.resetKey}
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
  turn: () => ChatTurn
  last: () => boolean
  chat: ChatTranscriptProps
  answers: () => Record<string, QuestionnaireAnswers>
  setAnswers: (value: Record<string, QuestionnaireAnswers>) => void
}

function ChatTurnView(props: TurnViewProps): JSX.Element {
  const segments = createMemo(() => segmentTurnEntries(props.turn().entries))
  const segmentIds = createMemo<readonly string[]>(
    () => segments().map((segment) => segment.id),
    [],
    { equals: sameIds }
  )
  const segmentById = createMemo(() => new Map(segments().map((segment) => [segment.id, segment])))
  const live = () => props.last() && props.chat.running === true
  const hasReply = () => props.turn().entries.length > 0 || live()

  return (
    <>
      <Show when={props.turn().user}>
        {(user) => (
          <Message
            role="user"
            label="You"
            anchorId={`${props.turn().id}:user`}
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
          anchorId={`${props.turn().id}:reply`}
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

type Segment = ReturnType<typeof segmentTurnEntries>[number]

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
      <Show when={activity()}>{(entries) => <ActivityColumn entries={entries} />}</Show>
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

function TruncationNote(props: { limit?: number }): JSX.Element {
  return (
    <Marker
      variant="note"
      tone="warning"
      label={`Showing the first ${(props.limit ?? CHAT_ASSISTANT_TEXT_LIMIT).toLocaleString('en-US')} characters`}
      description="The rest of this message is not shown."
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

function ActivityColumn(props: { entries: () => readonly ChatTurnActivity[] }): JSX.Element {
  const ids = createMemo<readonly string[]>(() => props.entries().map((entry) => entry.id), [], {
    equals: sameIds,
  })
  const byId = createMemo(() => new Map(props.entries().map((entry) => [entry.id, entry])))
  return (
    <Trace>
      <For each={ids()}>{(id) => <ActivityLine item={() => byId().get(id)?.item} />}</For>
    </Trace>
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
            when={item().text !== undefined && inline() === undefined ? item().text : undefined}
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
  entry: Exclude<ChatTurnEntry, ChatTurnActivity>
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

function TextEntry(props: { entry: ChatTurnText; streaming: boolean }): JSX.Element {
  return (
    <div
      class="flex min-w-0 flex-col gap-2 rounded-md data-revealed:bg-primary-subtle"
      data-entry-id={props.entry.id}
      data-event-id={props.entry.id}
      data-source={props.entry.source}
    >
      <MessageText
        text={props.entry.text}
        streaming={props.streaming && props.entry.source === 'delta'}
        codeBlockProps={{ maxHeight: '24rem' }}
      />
      <Show when={props.entry.truncated}>
        <TruncationNote />
      </Show>
      <Show when={props.entry.failed}>
        <Marker variant="note" tone="danger" label="The runtime reported an error for this turn." />
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
      item().text ??
      (item().label !== item().kind ? item().label : 'The runtime is waiting for an answer.')
  )
  const questions = createMemo(() => [
    { id: 'answer', prompt: prompt(), allowText: true, textLabel: 'Answer question' },
  ])
  const disabledReason = () =>
    chatTranscriptActionDisabledReason('question', props.chat.onResolveQuestion)
  const requested = () => item().state === 'requested'
  const submit = async (value: QuestionnaireAnswers) => {
    const event = item().event
    const text = value.answer?.text.trim() ?? ''
    if (!event || text.length === 0) return
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
            meta={item().state ? STATE_WORDS[item().state!] : undefined}
            status={item().state === 'expired' ? 'cancelled' : undefined}
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
