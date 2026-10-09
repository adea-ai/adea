import { createEffect, For, on, onCleanup, onMount, Show, createSignal, type JSX } from 'solid-js'

import type { ChatConversation, ChatConversationModel, TranscriptAccumulator } from './model'
import { ChatRuntimeError, createTranscriptAccumulator, transcriptWindow } from './model'
import {
  ChatComposer,
  type ChatComposerProps,
  type ChatDraftChange,
  type ChatInputAuthority,
} from './chat-composer'
import { ChatTranscript, type ChatTranscriptProps } from './chat-transcript'
import { DirectSessionHandoffControls } from './handoff-controls'
import {
  deriveDirectSessionHandoff,
  deriveHandoffInputFromConversation,
  handoffActionReducer,
  initialHandoffActionState,
  type DirectSessionHandoffSupply,
  type DirectSessionHandoffView,
  type HandoffActionKind,
} from './model/handoff'
import { statusLabel } from './presentation'
import './chat.css'
import { statusDotVariants } from '@adea-ai/ui/components/ui/status-chip'
import { Button } from '@adea-ai/ui/components/ui/button'

export type ChatViewProps = Readonly<{
  conversation: ChatConversation
  model?: Pick<ChatConversationModel, 'openTranscript' | 'send' | 'cancel'> &
    Partial<
      Pick<
        ChatConversationModel,
        'transfer' | 'draftRevision' | 'setDraftIfCurrent' | 'createPasteBlockId'
      >
    >
  authority?: ChatInputAuthority
  connected?: boolean
  awaitingApproval?: boolean
  onSend?: (text: string) => void | Promise<void>
  onSteer?: (text: string) => void | Promise<void>
  onStop?: () => void | Promise<void>
  onDraftChange?: ChatDraftChange
  draftRevision?: number
  decisionRequest?: ChatComposerProps['decisionRequest']
  decisionConsumer?: ChatComposerProps['decisionConsumer']
  onResolveApproval?: ChatTranscriptProps['onResolveApproval']
  onResolveQuestion?: ChatTranscriptProps['onResolveQuestion']
  onJumpToTerminal?: () => void
  autoAttach?: boolean
  handoffView?: DirectSessionHandoffView
  /** Production supplier config: derives the handoff view from the live
   *  conversation plus surface facts, with model-backed default actions.
   *  Omit entirely and no handoff section renders (fixture-safe). */
  handoff?: DirectSessionHandoffSupply
  onLeadStop?: () => void | Promise<void>
  onReconnectHandoff?: () => void | Promise<void>
  onReturnToUser?: () => void | Promise<void>
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
  // Handoff coordination state (#1177): the confirmed post-transfer mode,
  // a control conflict observed from a stale transfer receipt, and the
  // single-flight action machine. All reset when the selected session
  // changes so one session's coordination never leaks into another's.
  const [handoffModeOverride, setHandoffModeOverride] = createSignal<
    DirectSessionHandoffView['mode'] | undefined
  >(undefined)
  const [handoffConflict, setHandoffConflict] = createSignal(false)
  const [handoffAction, setHandoffAction] = createSignal(initialHandoffActionState)
  const dispatchHandoffAction = (event: Parameters<typeof handoffActionReducer>[1]): void => {
    setHandoffAction((state) => handoffActionReducer(state, event))
  }
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
  let fallbackPasteBlockId = 0
  const stop = async () => {
    if (props.onStop) return props.onStop()
    if (props.model) await props.model.cancel(props.conversation.runtimeSessionId)
  }

  createEffect(
    on(
      () => props.conversation.runtimeSessionId,
      () => {
        setHandoffModeOverride(undefined)
        setHandoffConflict(false)
        setHandoffAction(initialHandoffActionState)
      }
    )
  )

  const runHandoffAction = async (
    action: HandoffActionKind,
    work: () => void | Promise<void>
  ): Promise<void> => {
    dispatchHandoffAction({ type: 'start', action })
    try {
      await work()
      dispatchHandoffAction({ type: 'succeed' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Handoff action failed.'
      dispatchHandoffAction({ type: 'fail', action, message })
      if (
        error instanceof ChatRuntimeError &&
        (error.code === 'stale_generation' || error.code === 'stale_version')
      ) {
        // A stale transfer receipt proves concurrent coordination: park an
        // explicit conflict instead of retrying blindly or failing silently.
        setHandoffConflict(true)
      }
    }
  }

  const leadStopAction = (): void | Promise<void> => {
    if (props.onLeadStop) return props.onLeadStop()
    if (!props.model) return undefined
    return void runHandoffAction('lead_stop', stop)
  }

  const returnToUserAction = (): void | Promise<void> => {
    if (props.onReturnToUser) return props.onReturnToUser()
    const transfer = props.model?.transfer
    if (!transfer) return undefined
    // The persisted authoritative transition: input ownership moves to this
    // (chat) surface via generation- and version-fenced transferInput. The
    // confirmed receipt presents as returned-to-user; drafts survive because
    // transfer never touches them (pinned by transfer tests).
    return void runHandoffAction('return_to_user', async () => {
      await transfer(props.conversation.runtimeSessionId, { fromView: 'dev', toView: 'chat' })
      setHandoffModeOverride('returned_to_user')
    })
  }

  const reconnectHandoffAction = (): void | Promise<void> => {
    if (props.onReconnectHandoff) return props.onReconnectHandoff()
    if (!props.model) return undefined
    return void attach()
  }

  const suppliedHandoffView = (): DirectSessionHandoffView | undefined => {
    if (props.handoffView) return props.handoffView
    const supply = props.handoff
    if (!supply) return undefined
    const availability = transcript().availability.status
    return deriveDirectSessionHandoff(
      deriveHandoffInputFromConversation({
        conversation: props.conversation,
        authority: props.authority ?? 'chat',
        connected: connected(),
        generationCurrent:
          availability !== 'stale_generation' && availability !== 'resync_required',
        harnessRuns: supply.harnessRuns,
        awaitingApproval: props.awaitingApproval,
        mode: handoffModeOverride() ?? supply.mode,
        controlConflict: supply.controlConflict ?? handoffConflict(),
      })
    )
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
          <span aria-hidden="true" class={statusDotVariants({ tone: 'neutral' })} />
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
      <Show when={suppliedHandoffView()}>
        {(view) => {
          const action = handoffAction()
          return (
            <DirectSessionHandoffControls
              view={view()}
              onLeadStop={props.onLeadStop ?? (props.model ? leadStopAction : undefined)}
              onReconnect={
                props.onReconnectHandoff ?? (props.model ? reconnectHandoffAction : undefined)
              }
              onReturnToUser={
                props.onReturnToUser ?? (props.model?.transfer ? returnToUserAction : undefined)
              }
              busyAction={action.status === 'busy' ? action.action : undefined}
              actionError={action.status === 'error' ? action.message : undefined}
            />
          )
        }}
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
                decisionRequest={props.decisionRequest}
                decisionConsumer={props.decisionConsumer}
                createPasteBlockId={() =>
                  props.model?.createPasteBlockId?.(
                    props.conversation.runtimeSessionId,
                    props.conversation.generation
                  ) ?? `chat-paste-${++fallbackPasteBlockId}`
                }
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
