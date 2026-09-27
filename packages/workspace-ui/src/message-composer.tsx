import type { AgentSummary, ArtifactSummary, ConversationParticipantRef } from '@adea-ai/types'
import { AtSign, LoaderCircle, Mic, MicOff, X } from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import {
  ComposerAttachmentButton,
  MessageComposer as SharedMessageComposer,
} from '@adea-ai/ui/components/conversation'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@adea-ai/ui/components/ui/tooltip'
import type { TranscriptionProvider, TranscriptionSession, TranscriptionState } from './platform'
import { keyedRows } from './keyed-rows'
import { mergeTranscription } from './transcription'
import { createClientRequestId } from './request-id'
import { parseAgentMentions } from './workspace-model'

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
  const [sending, setSending] = createSignal(false)
  const [transcriptionError, setTranscriptionError] = createSignal<string | null>(null)
  const [transcriptionState, setTranscriptionState] = createSignal<TranscriptionState>(
    props.transcription ? 'idle' : 'unavailable'
  )
  const [form, setForm] = createSignal<HTMLFormElement>()
  let transcriptionSession: TranscriptionSession | null = null
  const artifactRows = keyedRows(
    () => props.artifacts,
    (artifact) => artifact.id
  )

  onCleanup(() => transcriptionSession?.cancel())

  // The public composer exposes its form ref and guarantees a textarea. Keep
  // Adea's per-channel accessible description and focus restoration on that
  // native field without taking ownership of the shared form behavior.
  createEffect(() => {
    const formElement = form()
    const channelId = props.channelId
    if (!formElement) return
    const textarea = formElement.querySelector('textarea')
    if (!textarea) return
    textarea.id = `composer-${channelId}`
    textarea.setAttribute('aria-describedby', `composer-help-${channelId}`)
  })

  const focusDraft = () => requestAnimationFrame(() => form()?.querySelector('textarea')?.focus())

  const mentionSuggestions = createMemo(() => {
    const match = props.draft.match(/(?:^|\s)@([^\n]*)$/)
    if (!match) return []
    const query = match[1]?.toLocaleLowerCase() ?? ''
    return props.agents.filter(({ name }) => name.toLocaleLowerCase().includes(query)).slice(0, 5)
  })

  const submit = async () => {
    const bodyText = props.draft.trim()
    if (!bodyText || props.disabled || sending()) return
    setSending(true)
    try {
      await props.onSubmit({
        artifactIds: attachmentIds(),
        bodyText,
        idempotencyKey: createClientRequestId(),
        mentions: parseAgentMentions(bodyText, props.agents),
      })
      props.onDraftChange('')
      setAttachmentIds([])
    } finally {
      setSending(false)
    }
  }

  const insertMention = (agent: AgentSummary) => {
    props.onDraftChange(props.draft.replace(/@[^\n]*$/, `@${agent.name} `))
    focusDraft()
  }

  const dictate = async () => {
    if (!props.transcription) return
    if (transcriptionState() === 'listening' || transcriptionState() === 'processing') {
      transcriptionSession?.cancel()
      transcriptionSession = null
      setTranscriptionState('cancelled')
      focusDraft()
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
      focusDraft()
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
      <SharedMessageComposer
        ref={setForm}
        class="conventional-composer__shared"
        value={props.draft}
        onValueChange={props.onDraftChange}
        onSubmit={submit}
        placeholder={props.disabled ? 'Messaging is unavailable' : 'Type something...'}
        disabled={props.disabled || sending()}
        menu={
          <>
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
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-2xs"
                          aria-label={`Remove ${artifact()?.filename ?? 'Artifact'}`}
                          onClick={() =>
                            setAttachmentIds((ids) => ids.filter((id) => id !== artifactId))
                          }
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </span>
                    )
                  }}
                </For>
              </div>
            </Show>
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
            <p id={`composer-help-${props.channelId}`} class="visually-hidden">
              Enter to send · Shift+Enter newline
            </p>
          </>
        }
        leading={
          <div class="conventional-composer__attachment-control">
            <ComposerAttachmentButton
              count={attachmentIds().length}
              open={attachmentsOpen()}
              aria-label="Attach an Artifact"
              disabled={props.disabled || !props.artifacts.length}
              onClick={() => setAttachmentsOpen((open) => !open)}
            />
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
        }
        trailing={
          <Tooltip>
            <TooltipTrigger
              as={Button}
              variant="ghost"
              size="icon-sm"
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
                  <Show when={transcriptionState() === 'listening'} fallback={<Mic />}>
                    <MicOff />
                  </Show>
                }
              >
                <LoaderCircle class="conventional-spin" />
              </Show>
            </TooltipTrigger>
            <TooltipContent hideArrow placement="top" gutter={4} data-slot="tooltip-content">
              {props.transcription
                ? `Dictate with ${props.transcription.label}`
                : 'Dictation is available in Adea Desktop'}
            </TooltipContent>
          </Tooltip>
        }
      />
      <div class="conventional-composer__status" aria-live="polite">
        <Show when={transcriptionError()} keyed>
          {(message) => <p role="alert">{message}</p>}
        </Show>
        <Show when={!transcriptionError() && sending()}>
          <p class="conventional-composer__status--muted">Sending message…</p>
        </Show>
        <Show when={!transcriptionError() && !sending() && transcriptionState() === 'listening'}>
          <p>Listening… Select the microphone again to cancel.</p>
        </Show>
        <Show when={!transcriptionError() && !sending() && transcriptionState() === 'processing'}>
          <p>Preparing editable transcript…</p>
        </Show>
        <Show when={!transcriptionError() && !sending() && transcriptionState() === 'cancelled'}>
          <p>Dictation cancelled. Your draft was preserved.</p>
        </Show>
      </div>
    </section>
  )
}
