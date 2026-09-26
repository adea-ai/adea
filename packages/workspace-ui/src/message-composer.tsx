import type { AgentSummary, ArtifactSummary, ConversationParticipantRef } from '@adea-ai/types'
import { AtSign, LoaderCircle, Mic, MicOff, Paperclip, Send, X } from 'lucide-solid'
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import { Tooltip, TooltipContent, TooltipTrigger } from '@adea-ai/app-ui/components/ui/tooltip'
import type { TranscriptionProvider, TranscriptionSession, TranscriptionState } from './platform'
import { keyedRows } from './keyed-rows'
import { mergeTranscription } from './transcription'
import { createClientRequestId } from './request-id'
import { composerKeyboardAction, parseAgentMentions } from './workspace-model'

export type ComposerSubmission = Readonly<{
  artifactIds: readonly string[]
  bodyText: string
  idempotencyKey: string
  mentions: readonly ConversationParticipantRef[]
}>

export function MessageComposer(props: {
  agents: readonly AgentSummary[]
  artifacts: readonly ArtifactSummary[]
  channelId: string
  disabled?: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: (submission: ComposerSubmission) => Promise<void>
  replyLabel?: string
  transcription?: TranscriptionProvider
}) {
  const [attachmentIds, setAttachmentIds] = createSignal<readonly string[]>([])
  const [attachmentsOpen, setAttachmentsOpen] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [sending, setSending] = createSignal(false)
  const [transcriptionError, setTranscriptionError] = createSignal<string | null>(null)
  const [transcriptionState, setTranscriptionState] = createSignal<TranscriptionState>(
    props.transcription ? 'idle' : 'unavailable'
  )
  let transcriptionSession: TranscriptionSession | null = null
  const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>()
  const artifactRows = keyedRows(
    () => props.artifacts,
    (artifact) => artifact.id
  )

  onCleanup(() => transcriptionSession?.cancel())

  const mentionSuggestions = createMemo(() => {
    const match = props.draft.match(/(?:^|\s)@([^\n]*)$/)
    if (!match) return []
    const query = match[1]?.toLocaleLowerCase() ?? ''
    return props.agents.filter(({ name }) => name.toLocaleLowerCase().includes(query)).slice(0, 5)
  })

  const send = async () => {
    const bodyText = props.draft.trim()
    if (!bodyText || props.disabled || sending()) return
    setSending(true)
    setError(null)
    try {
      await props.onSubmit({
        artifactIds: attachmentIds(),
        bodyText,
        idempotencyKey: createClientRequestId(),
        mentions: parseAgentMentions(bodyText, props.agents),
      })
      props.onDraftChange('')
      setAttachmentIds([])
    } catch {
      setError('Message not sent. Your draft is still here; retry when the connection recovers.')
    } finally {
      setSending(false)
    }
  }

  const insertMention = (agent: AgentSummary) => {
    props.onDraftChange(props.draft.replace(/@[^\n]*$/, `@${agent.name} `))
    requestAnimationFrame(() => textarea()?.focus())
  }

  const dictate = async () => {
    if (!props.transcription) return
    if (transcriptionState() === 'listening' || transcriptionState() === 'processing') {
      transcriptionSession?.cancel()
      transcriptionSession = null
      setTranscriptionState('cancelled')
      requestAnimationFrame(() => textarea()?.focus())
      return
    }
    setTranscriptionError(null)
    let activeSession: TranscriptionSession | null = null
    try {
      const permission = await props.transcription.requestPermission()
      if (permission !== 'granted') {
        setTranscriptionState(permission === 'unavailable' ? 'unavailable' : 'error')
        setTranscriptionError(
          permission === 'denied'
            ? 'Microphone access is off. Enable it in system privacy settings, then retry.'
            : 'Dictation is unavailable on this device.'
        )
        return
      }
      const session = await props.transcription.start()
      activeSession = session
      transcriptionSession = session
      setTranscriptionState('listening')
      const result = await session.completion
      if (transcriptionSession !== session) return
      setTranscriptionState('processing')
      props.onDraftChange(mergeTranscription(props.draft, result.text))
      transcriptionSession = null
      setTranscriptionState('idle')
      requestAnimationFrame(() => textarea()?.focus())
    } catch (caught) {
      if (activeSession && transcriptionSession !== activeSession) return
      transcriptionSession = null
      setTranscriptionState('error')
      setTranscriptionError(
        caught instanceof DOMException && caught.name === 'NotAllowedError'
          ? 'Microphone access is off. Enable it in system privacy settings, then retry.'
          : 'Dictation stopped unexpectedly. Your existing draft is unchanged.'
      )
    }
  }

  return (
    <section
      class="conventional-composer"
      aria-label={props.replyLabel ? `Reply to ${props.replyLabel}` : 'Message composer'}
    >
      <Show when={props.replyLabel}>
        {(replyLabel) => (
          <div class="conventional-composer__context">
            <span>Replying in thread · {replyLabel()}</span>
          </div>
        )}
      </Show>
      <Show when={attachmentIds().length}>
        <div class="conventional-composer__attachments" aria-label="Selected attachments">
          <For each={attachmentIds()}>
            {(artifactId) => {
              const artifact = () => props.artifacts.find(({ id }) => id === artifactId)
              return (
                <span>
                  {artifact()?.filename ?? 'Artifact'}
                  <button
                    type="button"
                    aria-label={`Remove ${artifact()?.filename ?? 'Artifact'}`}
                    onClick={() => setAttachmentIds((ids) => ids.filter((id) => id !== artifactId))}
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
              )
            }}
          </For>
        </div>
      </Show>
      <div class="conventional-composer__editor">
        <label for={`composer-${props.channelId}`} class="visually-hidden">
          Message
        </label>
        <textarea
          ref={setTextarea}
          id={`composer-${props.channelId}`}
          value={props.draft}
          rows={3}
          disabled={props.disabled || sending()}
          placeholder={props.disabled ? 'Messaging is unavailable' : 'Type something...'}
          aria-describedby={`composer-help-${props.channelId}`}
          onInput={(event) => props.onDraftChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            const action = composerKeyboardAction({
              isComposing: event.isComposing,
              key: event.key,
              shiftKey: event.shiftKey,
            })
            if (action === 'send') {
              event.preventDefault()
              void send()
            }
          }}
        />
        <Show when={mentionSuggestions().length}>
          <div class="conventional-mention-menu" aria-label="Mention an Agent">
            <For each={mentionSuggestions()}>
              {(agent) => (
                <button type="button" onClick={() => insertMention(agent)}>
                  <AtSign aria-hidden="true" />
                  {agent.name}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="conventional-composer__toolbar">
        <div class="conventional-composer__attachment-control">
          <button
            type="button"
            aria-label="Attach an Artifact"
            aria-expanded={attachmentsOpen()}
            disabled={props.disabled || !props.artifacts.length}
            onClick={() => setAttachmentsOpen((open) => !open)}
          >
            <Paperclip aria-hidden="true" />
          </button>
          <Show when={attachmentsOpen()}>
            <div class="conventional-attachment-menu">
              <strong>Attach Artifact</strong>
              <For each={artifactRows()}>
                {(entry) => (
                  <label>
                    <input
                      type="checkbox"
                      checked={attachmentIds().includes(entry.item().id)}
                      disabled={entry.item().availability !== 'available'}
                      onChange={(event) =>
                        setAttachmentIds((ids) =>
                          event.currentTarget.checked
                            ? [...ids, entry.item().id]
                            : ids.filter((id) => id !== entry.item().id)
                        )
                      }
                    />
                    <span>{entry.item().filename}</span>
                    <small>{entry.item().availability}</small>
                  </label>
                )}
              </For>
            </div>
          </Show>
        </div>
        <p id={`composer-help-${props.channelId}`} class="visually-hidden">
          Enter to send · Shift+Enter newline · Mod+Shift+M focus
        </p>
        <div class="conventional-composer__voice-control">
          <Tooltip>
            <TooltipTrigger
              aria-label={
                transcriptionState() === 'listening' || transcriptionState() === 'processing'
                  ? 'Cancel dictation'
                  : 'Start dictation'
              }
              aria-pressed={transcriptionState() === 'listening' || undefined}
              disabled={props.disabled || sending() || transcriptionState() === 'unavailable'}
              onClick={() => void dictate()}
            >
              <Show
                when={transcriptionState() === 'processing'}
                fallback={
                  <Show
                    when={transcriptionState() === 'listening'}
                    fallback={<Mic aria-hidden="true" />}
                  >
                    <MicOff aria-hidden="true" />
                  </Show>
                }
              >
                <LoaderCircle aria-hidden="true" class="conventional-spin" />
              </Show>
            </TooltipTrigger>
            <TooltipContent>
              {props.transcription
                ? `Dictate with ${props.transcription.label}`
                : 'Dictation is available in Adea Desktop'}
            </TooltipContent>
          </Tooltip>
        </div>
        <button
          type="button"
          class="conventional-send-button"
          aria-label={sending() ? 'Sending message' : 'Send message'}
          disabled={props.disabled || sending() || !props.draft.trim()}
          onClick={() => void send()}
        >
          <Send aria-hidden="true" />
          <span class="visually-hidden">{sending() ? 'Sending' : 'Send'}</span>
        </button>
      </div>
      <div class="conventional-composer__status" aria-live="polite">
        <Show when={error() ?? transcriptionError()} keyed>
          {(message) => <p role="alert">{message}</p>}
        </Show>
        <Show when={!error() && !transcriptionError() && sending()}>
          <p class="conventional-composer__status--muted">Sending message…</p>
        </Show>
        <Show
          when={
            !error() && !transcriptionError() && !sending() && transcriptionState() === 'listening'
          }
        >
          <p>Listening… Select the microphone again to cancel.</p>
        </Show>
        <Show
          when={
            !error() && !transcriptionError() && !sending() && transcriptionState() === 'processing'
          }
        >
          <p>Preparing editable transcript…</p>
        </Show>
        <Show
          when={
            !error() && !transcriptionError() && !sending() && transcriptionState() === 'cancelled'
          }
        >
          <p>Dictation cancelled. Your draft was preserved.</p>
        </Show>
      </div>
    </section>
  )
}
