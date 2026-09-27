import { Show, createEffect, createMemo, createSignal, on, type JSX } from 'solid-js'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { ConversationSurface } from '@adea-ai/ui/components/conversation'
import { TranscriptComposition } from '@adea-ai/ui/components/conversation/transcript-composition'
import type { RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'

import { projectTranscriptEvents, type ChatTranscriptItem } from './presentation'
import type { TranscriptAccumulator } from './model'
import { runtimeTranscriptRows } from './transcript-composition'

export type ChatTranscriptProps = Readonly<{
  events: readonly RuntimeEvent[]
  /** Canonical session and generation scope; never inferred from display content. */
  resetKey: string
  projection?: RuntimeSession['projection']
  transcript?: TranscriptAccumulator
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
import { chatTranscriptActionDisabledReason } from './transcript-availability'

function eventStateLabel(item: ChatTranscriptItem): string {
  return item.state ? item.state.replace('_', ' ') : item.kind
}

function runtimeEventText(item: ChatTranscriptItem): string {
  if (item.text) return item.text
  if (item.role === 'tool') return 'Runtime tool event received.'
  if (item.role === 'approval') return 'Approval is required before the runtime can continue.'
  if (item.role === 'question') return 'The runtime is waiting for an answer.'
  if (item.role === 'subagent') return 'A subagent activity was observed.'
  return item.label
}

export function ChatTranscript(props: ChatTranscriptProps): JSX.Element {
  const [answers, setAnswers] = createSignal<Record<string, string>>({})
  createEffect(
    on(
      () => props.resetKey,
      () => setAnswers({})
    )
  )
  // Memoized, not a plain accessor: the projection walks the whole retained
  // window (up to CHAT_EVENT_RETENTION_LIMIT events) and both the empty-state
  // check below and the list read it, so an unmemoized accessor projected the
  // same window twice on every reactive re-evaluation.
  const items = createMemo(() =>
    projectTranscriptEvents(
      props.events,
      props.projection ? { projection: props.projection } : undefined
    )
  )
  const availability = () => props.transcript?.availability
  const retention = () => props.transcript?.retention
  const rows = createMemo(() => runtimeTranscriptRows(items()))

  return (
    <ConversationSurface
      class="dev-chat__stream"
      aria-label="Conversation transcript"
      aria-live="polite"
      initialReadingPosition={props.readingPosition}
      onReadingPositionChange={props.onReadingPositionChange}
    >
      <div class="dev-chat__entries">
        <Show when={availability()?.status === 'resync_required'}>
          <div class="dev-chat__notice" role="alert">
            <p>Transcript gap detected. Reconnect to recover the missing runtime events.</p>
          </div>
        </Show>
        <Show when={availability()?.status === 'stale_generation'}>
          <div class="dev-chat__notice" role="alert">
            <p>This transcript belongs to an older runtime generation.</p>
          </div>
        </Show>
        <Show when={retention()?.complete === false}>
          <div class="dev-chat__notice" role="status">
            <p>Transcript history is bounded; older events require a runtime checkpoint.</p>
          </div>
        </Show>
        <Show when={props.projection === 'terminal_fallback'}>
          <div class="dev-chat__notice" role="status">
            <p>
              Structured events unavailable; showing the terminal transcript projection.
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
            </p>
          </div>
        </Show>
        <Show
          when={items().length > 0}
          fallback={<p class="dev-chat__empty">No runtime events yet.</p>}
        >
          <TranscriptComposition
            class="dev-chat__composition"
            rows={rows()}
            resetKey={props.resetKey}
            renderRow={(rowProps) => (
              <ChatTranscriptRow
                item={rowProps.row.value}
                answers={answers}
                setAnswers={setAnswers}
                props={props}
              />
            )}
          />
        </Show>
      </div>
    </ConversationSurface>
  )
}

function ChatTranscriptRow(props: {
  item: ChatTranscriptItem
  answers: () => Record<string, string>
  setAnswers: (value: Record<string, string>) => void
  props: ChatTranscriptProps
}): JSX.Element {
  const answer = () => props.answers()[props.item.id] ?? ''
  const approvalDisabledReason = () =>
    chatTranscriptActionDisabledReason('approval', props.props.onResolveApproval)
  const questionDisabledReason = () =>
    chatTranscriptActionDisabledReason('question', props.props.onResolveQuestion)
  const approvalReasonId = `dev-chat-approval-status-${props.item.id}`
  const questionReasonId = `dev-chat-question-status-${props.item.id}`
  return (
    <article class={`dev-chat__row dev-chat__row--${props.item.role}`}>
      <header class="dev-chat__row-header">
        <span>{props.item.label}</span>
        <span>{eventStateLabel(props.item)}</span>
      </header>
      <p class="dev-chat__text">{runtimeEventText(props.item)}</p>
      <Show when={props.item.role === 'approval' && props.item.state === 'requested'}>
        <div class="dev-chat__actions">
          <Show when={approvalDisabledReason()}>
            <p id={approvalReasonId} class="dev-chat__action-status" role="status">
              {approvalDisabledReason()}
            </p>
          </Show>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={approvalDisabledReason() !== undefined}
            aria-describedby={approvalDisabledReason() ? approvalReasonId : undefined}
            onClick={() => {
              if (props.item.event) props.props.onResolveApproval?.(props.item.event, 'approved')
            }}
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={approvalDisabledReason() !== undefined}
            aria-describedby={approvalDisabledReason() ? approvalReasonId : undefined}
            onClick={() => {
              if (props.item.event) props.props.onResolveApproval?.(props.item.event, 'denied')
            }}
          >
            Deny
          </Button>
        </div>
      </Show>
      <Show when={props.item.role === 'question' && props.item.state === 'requested'}>
        <div class="dev-chat__question">
          <label for={`dev-chat-question-${props.item.id}`}>Answer question</label>
          <Input
            id={`dev-chat-question-${props.item.id}`}
            value={answer()}
            onInput={(event) =>
              props.setAnswers({ ...props.answers(), [props.item.id]: event.currentTarget.value })
            }
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={answer().trim().length === 0 || questionDisabledReason() !== undefined}
            aria-describedby={questionDisabledReason() ? questionReasonId : undefined}
            onClick={() => {
              if (props.item.event)
                props.props.onResolveQuestion?.(props.item.event, answer().trim())
            }}
          >
            Submit answer
          </Button>
          <Show when={questionDisabledReason()}>
            <p id={questionReasonId} class="dev-chat__action-status" role="status">
              {questionDisabledReason()}
            </p>
          </Show>
        </div>
      </Show>
    </article>
  )
}
