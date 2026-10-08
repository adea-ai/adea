import type { AgentSummary, ArtifactSummary, ConversationParticipantRef } from '@adea-ai/types'
import { AtSign, Mic, MicOff, X } from 'lucide-solid'
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import {
  ComposerAttachmentButton,
  ComposerMenu,
  ComposerMenuItem,
  MessageComposer as SharedMessageComposer,
} from '@adea-ai/ui/components/conversation'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Checkbox } from '@adea-ai/ui/components/ui/checkbox'
import { Spinner } from '@adea-ai/ui/components/ui/spinner'
import type { TranscriptionProvider, TranscriptionSession, TranscriptionState } from './platform'
import { keyedRows } from './keyed-rows'
import { mergeTranscription } from './transcription'
import { createClientRequestId } from './request-id'
import { createComposerSubmissionIdentity } from './composer-submission-identity'
import { parseAgentMentions } from './workspace-text-match'

export type ComposerSubmission = Readonly<{
  artifactIds: readonly string[]
  bodyText: string
  idempotencyKey: string
  mentions: readonly ConversationParticipantRef[]
}>

export type ComposerSubmissionOutcome = Readonly<{ clearDraft: boolean }>

export function MessageComposer(props: {
  agents: readonly AgentSummary[]
  artifacts: readonly ArtifactSummary[]
  channelId: string
  disabled?: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: (submission: ComposerSubmission) => Promise<void | ComposerSubmissionOutcome>
  /** The thread this composer replies to, drawn as the shared reply strip. */
  replyTo?: { label: string; onDismiss: () => void }
  transcription?: TranscriptionProvider
}) {
  const [attachmentIds, setAttachmentIds] = createSignal<readonly string[]>([])
  const [attachmentsOpen, setAttachmentsOpen] = createSignal(false)
  const [sending, setSending] = createSignal(false)
  const [submissionError, setSubmissionError] = createSignal<string>()
  const [transcriptionError, setTranscriptionError] = createSignal<string | null>(null)
  const [transcriptionState, setTranscriptionState] = createSignal<TranscriptionState>(
    props.transcription ? 'idle' : 'unavailable'
  )
  let textarea: HTMLTextAreaElement | undefined
  let transcriptionSession: TranscriptionSession | null = null
  let disposed = false
  const submissionIdentity = createComposerSubmissionIdentity(createClientRequestId)
  const artifactRows = keyedRows(
    () => props.artifacts,
    (artifact) => artifact.id
  )

  onCleanup(() => {
    disposed = true
    transcriptionSession?.cancel()
  })

  const focusDraft = () => requestAnimationFrame(() => textarea?.focus())

  const mentionSuggestions = createMemo(() => {
    const match = props.draft.match(/(?:^|\s)@([^\n]*)$/)
    if (!match) return []
    const query = match[1]?.toLocaleLowerCase() ?? ''
    return props.agents.filter(({ name }) => name.toLocaleLowerCase().includes(query)).slice(0, 5)
  })

  const submit = async () => {
    const bodyText = props.draft.trim()
    const channelId = props.channelId
    if (!bodyText || props.disabled || sending()) return
    setSending(true)
    setSubmissionError(undefined)
    try {
      const content = {
        artifactIds: attachmentIds(),
        bodyText,
        mentions: parseAgentMentions(bodyText, props.agents),
      }
      const outcome = await props.onSubmit({
        ...content,
        idempotencyKey: submissionIdentity.key({ channelId, ...content }),
      })
      if (
        !disposed &&
        props.channelId === channelId &&
        props.draft.trim() === bodyText &&
        outcome?.clearDraft !== false
      ) {
        props.onDraftChange('')
        setAttachmentIds([])
        submissionIdentity.reset()
      }
    } catch {
      if (!disposed && props.channelId === channelId)
        setSubmissionError(
          'Your message could not be saved. Your draft is preserved; refresh the conversation and try again.'
        )
    } finally {
      if (!disposed) setSending(false)
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

  // Host progress rides the shared composer's own live region; sending and
  // send-failure copy stay the composer's own, so only dictation lines live here.
  const dictationStatus = (
    <>
      <Show when={transcriptionError()} keyed>
        {(message) => (
          <p role="alert" class="text-destructive px-2 text-xs">
            {message}
          </p>
        )}
      </Show>
      <Show when={!transcriptionError() && !sending() && transcriptionState() === 'listening'}>
        <p class="text-muted-foreground px-2 text-xs">
          Listening… Select the microphone again to cancel.
        </p>
      </Show>
      <Show when={!transcriptionError() && !sending() && transcriptionState() === 'processing'}>
        <p class="text-muted-foreground px-2 text-xs">Preparing editable transcript…</p>
      </Show>
      <Show when={!transcriptionError() && !sending() && transcriptionState() === 'cancelled'}>
        <p class="text-muted-foreground px-2 text-xs">
          Dictation cancelled. Your draft was preserved.
        </p>
      </Show>
    </>
  )

  return (
    <section aria-label={props.replyTo ? `Reply to ${props.replyTo.label}` : 'Message composer'}>
      <Show when={submissionError()}>{(message) => <p role="status">{message()}</p>}</Show>
      <SharedMessageComposer
        inputRef={(element) => {
          textarea = element
        }}
        inputId={`composer-${props.channelId}`}
        inputDescription="Enter to send · Shift+Enter newline · Mod+Shift+M focus"
        value={props.draft}
        onValueChange={props.onDraftChange}
        onSubmit={submit}
        placeholder={props.disabled ? 'Messaging is unavailable' : 'Type something...'}
        disabled={props.disabled || sending()}
        replyTo={props.replyTo}
        status={dictationStatus}
        menu={
          <>
            <Show when={attachmentIds().length}>
              <div
                class="border-border flex flex-wrap gap-1.5 border-b p-1.5"
                aria-label="Selected attachments"
              >
                <For each={attachmentIds()}>
                  {(artifactId) => {
                    const artifact = () => props.artifacts.find(({ id }) => id === artifactId)
                    const name = artifact()?.filename ?? 'Artifact'
                    return (
                      <span class="bg-primary-subtle inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs">
                        {name}
                        <ActionButton
                          type="button"
                          variant="ghost"
                          size="icon-2xs"
                          tooltip={`Remove ${name}`}
                          aria-label={`Remove ${name}`}
                          onClick={() =>
                            setAttachmentIds((ids) => ids.filter((id) => id !== artifactId))
                          }
                        >
                          <X aria-hidden="true" />
                        </ActionButton>
                      </span>
                    )
                  }}
                </For>
              </div>
            </Show>
            <Show when={mentionSuggestions().length}>
              <ComposerMenu label="Mention an Agent">
                <For each={mentionSuggestions()}>
                  {(agent) => (
                    <ComposerMenuItem type="button" onClick={() => insertMention(agent)}>
                      <AtSign aria-hidden="true" />
                      {agent.name}
                    </ComposerMenuItem>
                  )}
                </For>
              </ComposerMenu>
            </Show>
          </>
        }
        leading={
          <>
            <div class="relative">
              <ComposerAttachmentButton
                count={attachmentIds().length}
                open={attachmentsOpen()}
                aria-label={
                  attachmentIds().length === 0
                    ? 'Attach an Artifact'
                    : `${attachmentIds().length} Artifact${attachmentIds().length === 1 ? '' : 's'} attached, add an Artifact`
                }
                disabled={props.disabled || !props.artifacts.length}
                onClick={() => setAttachmentsOpen((open) => !open)}
              />
              <Show when={attachmentsOpen()}>
                <ComposerMenu label="Attach Artifact" class="absolute bottom-9 left-0 z-(--z-menu)">
                  <div class="text-muted-foreground px-2 py-1 text-2xs font-semibold">
                    Attach Artifact
                  </div>
                  <For each={artifactRows()}>
                    {(entry) => (
                      <Checkbox
                        label={<span>{entry.item().filename}</span>}
                        description={<small>{entry.item().availability}</small>}
                        checked={attachmentIds().includes(entry.item().id)}
                        disabled={entry.item().availability !== 'available'}
                        onChange={(checked: boolean) =>
                          setAttachmentIds((ids) =>
                            checked
                              ? [...ids, entry.item().id]
                              : ids.filter((id) => id !== entry.item().id)
                          )
                        }
                      />
                    )}
                  </For>
                </ComposerMenu>
              </Show>
            </div>
          </>
        }
        trailing={
          <ActionButton
            variant="ghost"
            size="icon-sm"
            tooltip={
              props.transcription
                ? `Dictate with ${props.transcription.label}`
                : 'Dictation is available in Adea Desktop'
            }
            tooltipSide="top"
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
              <Spinner size="sm" label={false} />
            </Show>
          </ActionButton>
        }
      />
    </section>
  )
}
