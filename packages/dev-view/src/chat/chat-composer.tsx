import { createComputed, createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import { AtomicChatComposer } from '@adea-ai/ui/components/conversation/atomic'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Label } from '@adea-ai/ui/components/ui/label'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'

import type { ChatConversation } from './model'
import type { ChatDraftValue } from './model'
import type { ChatDraftIdentity as ScopedChatDraftIdentity } from './draft'
import { chatComposerDisabledReason } from './composer-availability'
import {
  chatDraftScopeKey,
  createChatSendRequests,
  expandChatDraftForSend,
  normalizeChatDraft,
  submitChatDraftSnapshot,
} from './draft'
import {
  resolvedLocationLabel,
  resolveAndLaunchComposer,
  type ComposerAgentProfile,
  type ComposerCustomization,
  type ComposerDecisionConsumer,
  type ComposerMode,
  type DecisionPins,
} from './composer'

export type ChatInputAuthority = 'chat' | 'dev' | 'none'

export type ChatDraftIdentity = ScopedChatDraftIdentity

/**
 * Updates the canonical session draft. `expectedRevision` is supplied only
 * when an async send is completing; the host must reject the clear if another
 * composer has written a newer draft in the meantime.
 */
export type ChatDraftChange = (
  draft: ChatDraftValue,
  identity: ChatDraftIdentity,
  expectedRevision?: number
) => void

export type ChatComposerProps = Readonly<{
  conversation: ChatConversation
  authority?: ChatInputAuthority
  connected?: boolean
  awaitingApproval?: boolean
  busy?: boolean
  onSend?: (text: string) => void | Promise<void>
  onSteer?: (text: string) => void | Promise<void>
  onStop?: () => void | Promise<void>
  onDraftChange?: ChatDraftChange
  createPasteBlockId: () => string
  draftRevision?: number
  mode?: ComposerMode
  agentProfile?: ComposerAgentProfile
  agentProfiles?: readonly ComposerAgentProfile[]
  onModeChange?: (mode: ComposerMode) => void
  onAgentProfileChange?: (profileId: string) => void
  customization?: ComposerCustomization
  decisionRequest?: (input: {
    mode: ComposerMode
    objective: string
    explicitPins: DecisionPins
  }) => Parameters<ComposerDecisionConsumer['onResolved']>[1]
  decisionConsumer?: ComposerDecisionConsumer
}>

export { chatComposerDisabledReason } from './composer-availability'

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const [draft, setDraft] = createSignal<ChatDraftValue>(
    normalizeChatDraft({ text: props.conversation.draft, blocks: props.conversation.draftBlocks })
  )
  const sendRequests = createChatSendRequests()
  const [sendRevision, setSendRevision] = createSignal(0)
  const [mode, setMode] = createSignal<ComposerMode>(props.mode ?? 'auto')
  const [resolvedLocation, setResolvedLocation] = createSignal<string | undefined>(undefined)
  const [resolving, setResolving] = createSignal(false)
  const [resolutionStatus, setResolutionStatus] = createSignal<string>()
  const [sendStatus, setSendStatus] = createSignal<string>()
  let localDraftRevision = 0
  let mounted = true
  let latestDecisionRequestRevision = 0
  let previousDecisionIdentity: readonly unknown[] | undefined
  let previousSendIdentity: readonly unknown[] | undefined
  const [decisionEpoch, setDecisionEpoch] = createSignal(0)
  const [sendContextEpoch, setSendContextEpoch] = createSignal(0)
  const currentSendKey = () =>
    [
      props.conversation.scope.accountId,
      props.conversation.scope.workspaceId,
      props.conversation.scope.runtimeNodeId,
      props.conversation.runtimeSessionId,
      props.conversation.generation,
    ].join('\u0000')
  const decisionContext = () => {
    const request = props.decisionRequest
    const consumer = props.decisionConsumer
    if (
      typeof request !== 'function' ||
      typeof consumer?.client?.resolve !== 'function' ||
      typeof consumer.onResolved !== 'function'
    )
      return undefined
    return { request, consumer }
  }
  const decisionReady = () => decisionContext() !== undefined
  const currentDecisionIdentity = () => {
    const consumer = props.decisionConsumer
    return [
      props.decisionRequest,
      consumer,
      consumer?.client,
      consumer?.client?.resolve,
      consumer?.onResolved,
      consumer?.onOutcome,
      props.conversation.scope.accountId,
      props.conversation.scope.workspaceId,
      props.conversation.scope.runtimeNodeId,
      props.conversation.runtimeSessionId,
      props.conversation.generation,
      props.conversation.projectId,
      props.conversation.repoId,
      props.conversation.worktreeId,
      props.authority,
    ] as const
  }
  createComputed(() => {
    const identity = currentDecisionIdentity()
    const changed =
      previousDecisionIdentity === undefined ||
      identity.length !== previousDecisionIdentity.length ||
      identity.some((value, index) => !Object.is(value, previousDecisionIdentity?.[index]))
    if (!changed) return
    if (previousDecisionIdentity !== undefined) latestDecisionRequestRevision += 1
    previousDecisionIdentity = identity
    setDecisionEpoch((epoch) => epoch + 1)
  })
  createComputed(() => {
    const identity = [currentSendKey()] as const
    if (
      previousSendIdentity !== undefined &&
      identity.every((value, index) => Object.is(value, previousSendIdentity?.[index]))
    )
      return
    if (previousSendIdentity !== undefined) setSendContextEpoch((epoch) => epoch + 1)
    previousSendIdentity = identity
  })
  onCleanup(() => {
    mounted = false
    latestDecisionRequestRevision += 1
  })
  const currentDraftKey = () =>
    `${chatDraftScopeKey(props.conversation.scope)}:${props.conversation.runtimeSessionId}:${props.conversation.generation}`
  createEffect(() => {
    void currentDraftKey()
    void props.draftRevision
    setDraft(
      normalizeChatDraft({ text: props.conversation.draft, blocks: props.conversation.draftBlocks })
    )
  })
  let observedDecisionEpoch: number | undefined
  createEffect(() => {
    const epoch = decisionEpoch()
    const ready = decisionReady()
    if (observedDecisionEpoch !== undefined && observedDecisionEpoch !== epoch) {
      setResolving(false)
      setResolvedLocation(undefined)
      setResolutionStatus(undefined)
    }
    observedDecisionEpoch = epoch
    if (ready) return
    if (mode() !== 'auto') {
      setMode('auto')
      props.onModeChange?.('auto')
    }
    setResolvedLocation(undefined)
    setResolutionStatus(undefined)
  })
  let observedSendContextEpoch: number | undefined
  createEffect(() => {
    const epoch = sendContextEpoch()
    if (observedSendContextEpoch !== undefined && observedSendContextEpoch !== epoch)
      setSendStatus(undefined)
    observedSendContextEpoch = epoch
  })
  const authority = () => props.authority ?? 'chat'
  const sending = () => {
    void sendRevision()
    return sendRequests.isPending(currentSendKey())
  }
  const connected = () => props.connected ?? true
  const disabledReason = () =>
    chatComposerDisabledReason({
      conversation: props.conversation,
      authority: authority(),
      connected: connected(),
      awaitingApproval: props.awaitingApproval ?? false,
    })
  const disabled = () => disabledReason() !== undefined || sending()
  const steerUnavailable = () => typeof props.onSteer !== 'function'
  const stopUnavailable = () => typeof props.onStop !== 'function'
  const selectMode = (next: ComposerMode) => {
    setMode(next)
    setResolutionStatus(undefined)
    props.onModeChange?.(next)
  }
  const resolve = async () => {
    const context = decisionContext()
    if (!context) {
      setResolutionStatus(
        'Decision layer is unavailable. Retry after the Control Plane is connected.'
      )
      return
    }
    if (draft().text.trim().length === 0) {
      setResolutionStatus('A launch objective is required.')
      return
    }
    const requestRevision = ++latestDecisionRequestRevision
    const contextEpoch = decisionEpoch()
    const identity = currentDecisionIdentity()
    const isCurrent = () => {
      const currentContext = decisionContext()
      const currentIdentity = currentDecisionIdentity()
      return (
        mounted &&
        requestRevision === latestDecisionRequestRevision &&
        contextEpoch === decisionEpoch() &&
        currentContext?.request === context.request &&
        currentContext.consumer === context.consumer &&
        identity.length === currentIdentity.length &&
        identity.every((value, index) => Object.is(value, currentIdentity[index]))
      )
    }
    setResolving(true)
    setResolutionStatus(undefined)
    try {
      const objective = expandChatDraftForSend(draft())
      const explicitPins: DecisionPins =
        mode() === 'customize'
          ? {
              ...(props.customization?.harnessId
                ? { harness: { harnessId: props.customization.harnessId } }
                : {}),
              ...(props.customization?.modelId
                ? { model: { modelId: props.customization.modelId } }
                : {}),
              ...(props.customization?.runtimeDefinitionId
                ? { runtime: { runtimeDefinitionId: props.customization.runtimeDefinitionId } }
                : {}),
            }
          : {}
      const request = context.request({ mode: mode(), objective, explicitPins })
      if (!isCurrent()) return
      const guardedConsumer: ComposerDecisionConsumer = {
        client: {
          resolve: (decisionRequest) => {
            if (!isCurrent()) throw new Error('Decision request is no longer current.')
            return context.consumer.client.resolve(decisionRequest)
          },
        },
        onOutcome: (outcome) => {
          if (isCurrent()) context.consumer.onOutcome?.(outcome)
        },
        onResolved: async (resolution, decisionRequest) => {
          if (!isCurrent()) return
          await context.consumer.onResolved(resolution, decisionRequest)
        },
      }
      const outcome = await resolveAndLaunchComposer(guardedConsumer, request)
      if (!isCurrent()) return
      if (outcome.kind === 'resolved') {
        // Which location actually runs is the resolution's answer, not the
        // user's request: show it rather than implying the pin was honoured by
        // construction (#37/#186).
        setResolvedLocation(resolvedLocationLabel(outcome.resolution))
        setResolutionStatus('Launch decision received.')
      } else setResolutionStatus(outcome.message)
    } catch (error) {
      if (isCurrent())
        setResolutionStatus(
          error instanceof Error ? error.message : 'Decision layer is unavailable.'
        )
    } finally {
      if (mounted && requestRevision === latestDecisionRequestRevision) setResolving(false)
    }
  }
  const submit = async (input: {
    text: string
    blocks: ChatDraftValue['blocks']
    action: 'send' | 'steer' | 'queue'
  }) => {
    if (input.action === 'queue') return
    const submitMode = input.action
    const submittedDraft = normalizeChatDraft({ text: input.text, blocks: input.blocks })
    const deliver = submitMode === 'steer' ? props.onSteer : props.onSend
    if (disabled() || submittedDraft.text.trim().length === 0 || !deliver) return
    const submittedSendContextEpoch = sendContextEpoch()
    const isCurrentSend = () => mounted && submittedSendContextEpoch === sendContextEpoch()
    setSendStatus(undefined)
    const submittedIdentity: ChatDraftIdentity = {
      runtimeSessionId: props.conversation.runtimeSessionId,
      generation: props.conversation.generation,
      scopeKey: chatDraftScopeKey(props.conversation.scope),
    }
    const submittedDraftRevision = props.draftRevision ?? 0
    const submittedLocalDraftRevision = localDraftRevision
    const finishSend = sendRequests.begin(currentSendKey())
    setSendRevision((revision) => revision + 1)
    const submitted = {
      identity: submittedIdentity,
      hostRevision: submittedDraftRevision,
      localRevision: submittedLocalDraftRevision,
    }
    try {
      await submitChatDraftSnapshot({
        draft: submittedDraft,
        submitted,
        current: () => ({
          identity: {
            runtimeSessionId: props.conversation.runtimeSessionId,
            generation: props.conversation.generation,
            scopeKey: chatDraftScopeKey(props.conversation.scope),
          },
          hostRevision: props.draftRevision ?? 0,
          localRevision: localDraftRevision,
        }),
        deliver,
        clear: () => {
          if (!isCurrentSend()) return
          const empty: ChatDraftValue = { text: '', blocks: [] }
          setDraft(empty)
          props.onDraftChange?.(empty, submittedIdentity, submittedDraftRevision)
        },
      })
    } catch (error) {
      if (isCurrentSend())
        setSendStatus(error instanceof Error ? error.message : 'Message could not be sent.')
    } finally {
      finishSend()
      if (mounted) setSendRevision((revision) => revision + 1)
    }
  }

  return (
    <section class="dev-chat__composer" aria-label="Chat composer">
      <AtomicChatComposer
        value={draft().text}
        pasteTokens={{
          blocks: draft().blocks,
          createBlockId: props.createPasteBlockId,
          onChange: (nextDraft) => {
            const normalized = normalizeChatDraft(nextDraft)
            localDraftRevision += 1
            setDraft(normalized)
            props.onDraftChange?.(normalized, {
              runtimeSessionId: props.conversation.runtimeSessionId,
              generation: props.conversation.generation,
              scopeKey: chatDraftScopeKey(props.conversation.scope),
            })
          },
        }}
        onSubmit={submit}
        resetKey={currentDraftKey()}
        disabled={disabledReason() !== undefined}
        readOnly={sending()}
        inputLabel="Message runtime"
        placeholder="Send a message to the runtime"
        sendableActions={{
          send: typeof props.onSend === 'function' && draft().text.trim().length > 0,
        }}
        context={
          <Show when={decisionReady()}>
            <div>
              <div class="dev-chat__composer-controls" aria-label="Launch mode">
                <Label for="dev-chat-composer-agent">Agent</Label>
                <Show
                  when={props.agentProfiles && props.agentProfiles.length > 0}
                  fallback={<span>{props.agentProfile?.label ?? 'Select an agent profile'}</span>}
                >
                  <NativeSelect
                    id="dev-chat-composer-agent"
                    value={props.agentProfile?.id ?? ''}
                    onChange={(event) => props.onAgentProfileChange?.(event.currentTarget.value)}
                    options={[
                      { value: '', label: 'Select an agent profile' },
                      ...(props.agentProfiles ?? []).map((profile) => ({
                        value: profile.id,
                        label: profile.label,
                      })),
                    ]}
                  />
                </Show>
                <Label for="dev-chat-composer-mode">Mode</Label>
                <NativeSelect
                  id="dev-chat-composer-mode"
                  value={mode()}
                  onChange={(event) => selectMode(event.currentTarget.value as ComposerMode)}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'customize', label: 'Customize' },
                  ]}
                />
              </div>
              <Show when={mode() === 'customize' && props.customization}>
                {(customization) => (
                  <div class="dev-chat__composer-controls" aria-label="Customize launch pins">
                    <Label for="dev-chat-composer-harness">Harness</Label>
                    <NativeSelect
                      id="dev-chat-composer-harness"
                      value={customization().harnessId ?? ''}
                      onChange={(event) =>
                        customization().onHarnessChange?.(event.currentTarget.value)
                      }
                      options={[
                        { value: '', label: 'Control Plane default' },
                        ...customization().harnessOptions.map((option) => ({
                          value: option.id,
                          label: option.label,
                        })),
                      ]}
                    />
                    <Label for="dev-chat-composer-model">Model</Label>
                    <NativeSelect
                      id="dev-chat-composer-model"
                      value={customization().modelId ?? ''}
                      onChange={(event) =>
                        customization().onModelChange?.(event.currentTarget.value)
                      }
                      options={[
                        { value: '', label: 'Control Plane default' },
                        ...customization().modelOptions.map((option) => ({
                          value: option.id,
                          label: option.label,
                        })),
                      ]}
                    />
                    <Show when={(customization().runtimeOptions ?? []).length > 0}>
                      <Label for="dev-chat-composer-runtime">Location</Label>
                      <NativeSelect
                        id="dev-chat-composer-runtime"
                        value={customization().runtimeDefinitionId ?? ''}
                        onChange={(event) =>
                          customization().onRuntimeChange?.(event.currentTarget.value)
                        }
                        options={[
                          { value: '', label: 'Control Plane default' },
                          ...(customization().runtimeOptions ?? []).map((option) => ({
                            value: option.id,
                            label: option.label,
                          })),
                        ]}
                      />
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        }
        notices={
          <div>
            <p id="dev-chat-composer-status" role="status">
              <Show
                when={disabledReason()}
                fallback="Input is sent with the current runtime generation."
              >
                {(reason) => reason()}
              </Show>
            </p>
            <Show when={decisionReady() && resolvedLocation()}>
              {(label) => (
                <p class="dev-chat__composer-location" aria-live="polite">
                  Running on {label()}
                </p>
              )}
            </Show>
            <Show when={decisionReady() && mode() === 'customize'}>
              <p>Customize pins are submitted to the Control Plane and remain authoritative.</p>
            </Show>
            <Show when={decisionReady() && resolutionStatus()}>
              {(status) => <p role="alert">{status()}</p>}
            </Show>
            <Show when={sendStatus()}>{(status) => <p role="alert">{status()}</p>}</Show>
            <Show when={props.busy && steerUnavailable()}>
              <p role="status">Steer is unavailable on this host.</p>
            </Show>
          </div>
        }
        leadingActions={
          <Show when={decisionReady()}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled() || resolving() || draft().text.trim().length === 0}
              onClick={() => void resolve()}
            >
              {resolving() ? 'Resolving…' : 'Resolve & launch'}
            </Button>
          </Show>
        }
        trailingActions={
          <Show when={props.busy}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled() || stopUnavailable()}
              onClick={() => props.onStop?.()}
            >
              Stop
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled() || steerUnavailable() || draft().text.trim().length === 0}
              onClick={() =>
                void submit({ text: draft().text, blocks: draft().blocks, action: 'steer' })
              }
            >
              Steer
            </Button>
          </Show>
        }
      />
    </section>
  )
}
