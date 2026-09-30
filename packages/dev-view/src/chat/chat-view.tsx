import { createEffect, For, on, onCleanup, onMount, Show, createSignal, type JSX } from 'solid-js'

import type { ChatConversation, ChatConversationModel, TranscriptAccumulator } from './model'
import { createTranscriptAccumulator, transcriptWindow } from './model'
import { ChatComposer, type ChatDraftChange, type ChatInputAuthority } from './chat-composer'
import { ChatTranscript, type ChatTranscriptProps } from './chat-transcript'
import { statusLabel } from './presentation'
import './chat.css'
import { Button } from '@adea-ai/ui/components/ui/button'

export type ChatViewProps = Readonly<{
  conversation: ChatConversation
  model?: Pick<ChatConversationModel, 'openTranscript' | 'send' | 'cancel'> &
    Partial<Pick<ChatConversationModel, 'draftRevision' | 'setDraftIfCurrent'>>
  authority?: ChatInputAuthority
  connected?: boolean
  awaitingApproval?: boolean
  onSend?: (text: string) => void | Promise<void>
  onSteer?: (text: string) => void | Promise<void>
  onStop?: () => void | Promise<void>
  onDraftChange?: ChatDraftChange
  draftRevision?: number
  onResolveApproval?: ChatTranscriptProps['onResolveApproval']
  onResolveQuestion?: ChatTranscriptProps['onResolveQuestion']
  onJumpToTerminal?: () => void
  autoAttach?: boolean
  readingPosition?: ChatTranscriptProps['readingPosition']
  onReadingPositionChange?: (
    identity: Readonly<{ runtimeSessionId: string; generation: number }>,
    position: NonNullable<ChatTranscriptProps['readingPosition']>
  ) => void
}>

type StreamState = 'idle' | 'connecting' | 'connected' | 'disconnected'

function initialTranscript(conversation: ChatConversation): TranscriptAccumulator {
  if (conversation.events.length === 0)
    return createTranscriptAccumulator({
      runtimeSessionId: conversation.runtimeSessionId,
      generation: conversation.generation,
      fromSequence: conversation.retention.oldestSequence ?? '0',
    })
  return transcriptWindow(conversation.events, {
    runtimeSessionId: conversation.runtimeSessionId,
    generation: conversation.generation,
    fromSequence: conversation.retention.oldestSequence ?? '0',
    limit: 1_000,
  })
}

export function ChatView(props: ChatViewProps): JSX.Element {
  const [transcript, setTranscript] = createSignal<TranscriptAccumulator>(
    initialTranscript(props.conversation)
  )
  const [streamState, setStreamState] = createSignal<StreamState>(
    props.connected === false ? 'disconnected' : 'idle'
  )
  const [streamError, setStreamError] = createSignal<string | undefined>()
  const [mounted, setMounted] = createSignal(false)
  let closeStream: (() => void) | undefined
  let attachment = 0

  const detach = () => {
    attachment += 1
    closeStream?.()
    closeStream = undefined
  }

  const attach = async () => {
    const model = props.model
    if (!model) return
    detach()
    const currentAttachment = attachment
    const runtimeSessionId = props.conversation.runtimeSessionId
    const generation = props.conversation.generation
    setStreamState('connecting')
    setStreamError(undefined)
    try {
      const handle = await model.openTranscript(runtimeSessionId, {
        fromSequence:
          transcript().retention.newestSequence ??
          props.conversation.retention.newestSequence ??
          '0',
      })
      if (
        currentAttachment !== attachment ||
        props.conversation.runtimeSessionId !== runtimeSessionId ||
        props.conversation.generation !== generation
      ) {
        handle.close()
        return
      }
      // Push, not poll: the transcript re-renders when a frame is accepted
      // rather than on a 10Hz timer that ran for the whole time the surface
      // was open, whether or not anything was streaming.
      const unsubscribe = handle.subscribe((next) => {
        if (currentAttachment !== attachment) return
        setTranscript(next)
        if (
          next.availability.status === 'stale_generation' ||
          next.availability.status === 'resync_required'
        ) {
          detach()
          setStreamState('disconnected')
        }
      })
      closeStream = () => {
        unsubscribe()
        handle.close()
      }
      setTranscript(handle.state())
      setStreamState('connected')
    } catch (error) {
      if (currentAttachment !== attachment) return
      setStreamState('disconnected')
      setStreamError(error instanceof Error ? error.message : 'Runtime stream unavailable.')
    }
  }

  onMount(() => setMounted(true))
  createEffect(
    on(
      () =>
        [
          mounted(),
          props.conversation.runtimeSessionId,
          props.conversation.generation,
          props.model,
          props.autoAttach,
        ] as const,
      ([ready]) => {
        if (!ready) return
        detach()
        setTranscript(initialTranscript(props.conversation))
        setStreamState(props.connected === false ? 'disconnected' : 'idle')
        setStreamError(undefined)
        if (props.autoAttach !== false) void attach()
      }
    )
  )
  onCleanup(detach)

  const connected = () => props.connected ?? streamState() === 'connected'
  const status = () => transcript().availability.status
  const needsReconnect = () =>
    streamState() === 'disconnected' ||
    status() === 'resync_required' ||
    status() === 'stale_generation'
  const send = async (text: string) => {
    if (props.onSend) return props.onSend(text)
    await props.model?.send(props.conversation.runtimeSessionId, text)
  }
  const stop = async () => {
    if (props.onStop) return props.onStop()
    if (props.model) await props.model.cancel(props.conversation.runtimeSessionId)
  }

  const changeDraft: ChatDraftChange | undefined =
    props.onDraftChange ??
    (props.model?.setDraftIfCurrent
      ? (draft, identity, expectedRevision) => {
          props.model?.setDraftIfCurrent?.(
            identity.runtimeSessionId,
            identity.generation,
            draft,
            expectedRevision
          )
        }
      : undefined)

  return (
    <section class="dev-chat" aria-label={`Conversation ${props.conversation.title}`}>
      <header class="dev-chat__header">
        <div class="dev-chat__heading">
          <h2>{props.conversation.title}</h2>
          <p>
            Runtime session · generation {props.conversation.generation} ·{' '}
            {statusLabel(props.conversation.status)}
          </p>
        </div>
        <div class="dev-chat__status" role="status">
          <span aria-hidden="true" class="dev-status-dot" />
          <span>
            {streamState() === 'connecting' ? 'Connecting' : connected() ? 'Live' : 'Disconnected'}
          </span>
        </div>
      </header>
      <Show when={streamError() || needsReconnect()}>
        <div class="dev-chat__notice" role="alert">
          <p>{streamError() ?? 'Transcript needs a fresh runtime event window.'}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void attach()}
            disabled={!props.model}
          >
            Reconnect transcript
          </Button>
        </div>
      </Show>
      <For each={[`${props.conversation.runtimeSessionId}:${props.conversation.generation}`]}>
        {() => {
          const readingIdentity = {
            runtimeSessionId: props.conversation.runtimeSessionId,
            generation: props.conversation.generation,
          }
          return (
            <>
              <ChatTranscript
                events={transcript().events}
                resetKey={`${readingIdentity.runtimeSessionId}:${readingIdentity.generation}`}
                projection={props.conversation.projection}
                transcript={transcript()}
                onResolveApproval={props.onResolveApproval}
                onResolveQuestion={props.onResolveQuestion}
                onJumpToTerminal={props.onJumpToTerminal}
                readingPosition={props.readingPosition}
                onReadingPositionChange={(position) =>
                  props.onReadingPositionChange?.(readingIdentity, position)
                }
              />
              <ChatComposer
                conversation={props.conversation}
                authority={props.authority}
                connected={connected()}
                awaitingApproval={props.awaitingApproval}
                busy={props.conversation.status === 'active'}
                onSend={props.onSend || props.model ? send : undefined}
                onSteer={props.onSteer}
                onStop={props.onStop || props.model ? stop : undefined}
                onDraftChange={changeDraft}
                draftRevision={
                  props.draftRevision ??
                  props.model?.draftRevision?.(props.conversation.runtimeSessionId)
                }
              />
            </>
          )
        }}
      </For>
    </section>
  )
}
