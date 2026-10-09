import { createEffect, For, on, onCleanup, onMount, Show, createSignal, type JSX } from 'solid-js'

import type { ChatConversation, ChatConversationModel, TranscriptAccumulator } from './model'
import { createTranscriptAccumulator, transcriptWindow } from './model'
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
  initialHandoffActionState,
  runHandoffActionOnce,
  type DirectSessionHandoffSupply,
  type DirectSessionHandoffView,
  type HandoffActionKind,
  type HandoffActionState,
} from './model/handoff'
import { statusLabel } from './presentation'
import './chat.css'
import { statusDotVariants } from '@adea-ai/ui/components/ui/status-chip'
import { Button } from '@adea-ai/ui/components/ui/button'

/** Handoff section with provably reactive action state: the busy/error
 *  signals are read inside this component's own render, so no captured
 *  snapshot can go stale. */
function HandoffLiveSection(props: {
  view: DirectSessionHandoffView
  onLeadStop?: () => void | Promise<void>
  onSessionStop?: () => void | Promise<void>
  onReconnect?: () => void | Promise<void>
  leadUnwiredReason?: string
  actionState: () => HandoffActionState
}): JSX.Element {
  const busy = (): HandoffActionKind | undefined => {
    const state = props.actionState()
    return state.status === 'busy' ? state.action : undefined
  }
  const error = (): string | undefined => {
    const state = props.actionState()
    return state.status === 'error' ? state.message : undefined
  }
  return (
    <DirectSessionHandoffControls
      view={props.view}
      onLeadStop={props.onLeadStop}
      onSessionStop={props.onSessionStop}
      onReconnect={props.onReconnect}
      leadUnwiredReason={props.leadUnwiredReason}
      busyAction={busy()}
      actionError={error()}
    />
  )
}

export type ChatViewProps = Readonly<{
  conversation: ChatConversation
  model?: Pick<ChatConversationModel, 'openTranscript' | 'send' | 'cancel'> &
    Partial<
      Pick<ChatConversationModel, 'draftRevision' | 'setDraftIfCurrent' | 'createPasteBlockId'>
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
  onSessionStop?: () => void | Promise<void>
  onReconnectHandoff?: () => void | Promise<void>
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
  // Handoff action state (#1177): the single-flight action machine plus
  // the monotonic view/action epoch. Every session switch and every
  // admitted action start advances the epoch; late completions apply only
  // while it still reads the value captured at their admission. Session
  // identity alone cannot fence A -> B -> A, where an old A completion
  // would otherwise clear a new A action's busy state. All reset when the
  // selected session changes so one session's actions never leak into
  // another's.
  const [handoffEpoch, setHandoffEpoch] = createSignal(0)
  const [handoffAction, setHandoffAction] = createSignal(initialHandoffActionState)
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

  // Reset only when the SESSION changes: parent refreshes mint new
  // conversation objects for the same session (new generation, new draft
  // revision), and those must preserve receipts, conflicts, and in-flight
  // actions — currency against the canonical generation decides. A bare
  // `on(id)` effect cannot express this: it refires on every new object
  // even with an identical id, wiping a busy transfer mid-flight.
  let lastHandoffSessionId = props.conversation.runtimeSessionId
  createEffect(() => {
    const sessionId = props.conversation.runtimeSessionId
    if (sessionId === lastHandoffSessionId) return
    lastHandoffSessionId = sessionId
    setHandoffAction(initialHandoffActionState)
    setHandoffEpoch((epoch) => epoch + 1)
  })

  const runHandoffAction = (
    action: HandoffActionKind,
    work: () => unknown | Promise<unknown>,
    onSuccess?: (result: unknown) => void
  ): Promise<'completed' | 'rejected' | 'superseded'> => {
    // Fence on session identity plus the monotonic view/action epoch: a
    // session switch or a newer admitted action invalidates this
    // invocation's epoch, so its late completion commits nothing (this is
    // what closes A -> B -> A).
    const fenceId = props.conversation.runtimeSessionId
    let admittedEpoch = -1
    return runHandoffActionOnce({
      current: handoffAction,
      commit: setHandoffAction,
      action,
      work,
      onAdmitted: () => {
        setHandoffEpoch((epoch) => {
          admittedEpoch = epoch + 1
          return epoch + 1
        })
      },
      isCurrent: () =>
        props.conversation.runtimeSessionId === fenceId && handoffEpoch() === admittedEpoch,
      ...(onSuccess ? { onSuccess } : {}),
    })
  }

  // Stopping the LEAD runs only a caller-supplied canonical lead-turn
  // cancel: the bound harness stop below must never masquerade as it.
  const leadStopAction = (): void | Promise<void> | undefined => {
    if (!props.onLeadStop) return undefined
    return void runHandoffAction('lead_stop', () => props.onLeadStop?.())
  }

  // Stopping the SESSION run cancels the bound harness run. This is
  // session authority, visibly distinct from lead-turn cancellation.
  const sessionStopAction = (): void | Promise<void> => {
    if (props.onSessionStop) return props.onSessionStop()
    if (!props.model) return undefined
    return void runHandoffAction('session_stop', stop)
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
        connected: connected(),
        generationCurrent:
          availability !== 'stale_generation' && availability !== 'resync_required',
        harnessRuns: supply.harnessRuns,
        awaitingApproval: props.awaitingApproval,
        mode: supply.mode,
        leadTurn: supply.leadTurn,
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
        {(view) => (
          <HandoffLiveSection
            view={view()}
            onLeadStop={props.onLeadStop ? leadStopAction : undefined}
            onSessionStop={props.onSessionStop ?? (props.model ? sessionStopAction : undefined)}
            onReconnect={
              props.onReconnectHandoff ?? (props.model ? reconnectHandoffAction : undefined)
            }
            leadUnwiredReason="Lead cancellation is not connected in this host: wire onLeadStop to the canonical lead-turn cancel path."
            actionState={handoffAction}
          />
        )}
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
