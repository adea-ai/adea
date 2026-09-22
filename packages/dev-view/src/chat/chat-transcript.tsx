import { For, Show, createSignal, type JSX } from 'solid-js'
import type { RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'

import { projectTranscriptEvents, type ChatTranscriptItem } from './presentation'
import type { TranscriptAccumulator } from './model'

export type ChatTranscriptProps = Readonly<{
  events: readonly RuntimeEvent[]
  projection?: RuntimeSession['projection']
  transcript?: TranscriptAccumulator
  onResolveApproval?: (
    event: RuntimeEvent,
    resolution: 'approved' | 'denied'
  ) => void | Promise<void>
  onResolveQuestion?: (event: RuntimeEvent, answer: string) => void | Promise<void>
  onJumpToTerminal?: () => void
}>

export const CHAT_RESPONSE_UNAVAILABLE_REASON =
  'Runtime response controls are unavailable because this host has no authorized response operation.'

/**
 * Chat only makes an inline response actionable when the host supplies an
 * authorized, generation-bound operation. A rendered event is not proof that
 * the current host can safely resolve it, so the absence of the callback is a
 * visible disabled state instead of a silent no-op.
 */
export function chatTranscriptActionDisabledReason(
  kind: 'approval' | 'question',
  handler: unknown
): string | undefined {
  if (typeof handler === 'function') return undefined
  return `${kind === 'approval' ? 'Approval' : 'Question'} response unavailable: ${CHAT_RESPONSE_UNAVAILABLE_REASON}`
}

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
  const items = () =>
    projectTranscriptEvents(
      props.events,
      props.projection ? { projection: props.projection } : undefined
    )
  const availability = () => props.transcript?.availability
  const retention = () => props.transcript?.retention

  return (
    <section class="dev-chat__stream" aria-label="Conversation transcript" aria-live="polite">
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
              <button type="button" class="dev-button" onClick={() => props.onJumpToTerminal?.()}>
                Jump to terminal
              </button>
            </Show>
          </p>
        </div>
      </Show>
      <Show
        when={items().length > 0}
        fallback={<p class="dev-chat__empty">No runtime events yet.</p>}
      >
        <For each={items()}>
          {(item) => (
            <ChatTranscriptRow
              item={item}
              answers={answers}
              setAnswers={setAnswers}
              props={props}
            />
          )}
        </For>
      </Show>
    </section>
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
          <button
            type="button"
            class="dev-button"
            disabled={approvalDisabledReason() !== undefined}
            aria-describedby={approvalDisabledReason() ? approvalReasonId : undefined}
            onClick={() => {
              if (props.item.event) props.props.onResolveApproval?.(props.item.event, 'approved')
            }}
          >
            Approve
          </button>
          <button
            type="button"
            class="dev-button"
            disabled={approvalDisabledReason() !== undefined}
            aria-describedby={approvalDisabledReason() ? approvalReasonId : undefined}
            onClick={() => {
              if (props.item.event) props.props.onResolveApproval?.(props.item.event, 'denied')
            }}
          >
            Deny
          </button>
        </div>
      </Show>
      <Show when={props.item.role === 'question' && props.item.state === 'requested'}>
        <div class="dev-chat__question">
          <label for={`dev-chat-question-${props.item.id}`}>Answer question</label>
          <input
            id={`dev-chat-question-${props.item.id}`}
            value={answer()}
            onInput={(event) =>
              props.setAnswers({ ...props.answers(), [props.item.id]: event.currentTarget.value })
            }
          />
          <button
            type="button"
            class="dev-button"
            disabled={answer().trim().length === 0 || questionDisabledReason() !== undefined}
            aria-describedby={questionDisabledReason() ? questionReasonId : undefined}
            onClick={() => {
              if (props.item.event)
                props.props.onResolveQuestion?.(props.item.event, answer().trim())
            }}
          >
            Submit answer
          </button>
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
