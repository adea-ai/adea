import { createSignal, Show, type JSX } from 'solid-js'
import { ChatComposer as SharedChatComposer } from '@adea-ai/ui/components/conversation'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Label } from '@adea-ai/ui/components/ui/label'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'

import type { ChatConversation } from './model'
import { chatComposerDisabledReason } from './composer-availability'
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

export type ChatDraftIdentity = Readonly<Pick<ChatConversation, 'runtimeSessionId' | 'generation'>>

/**
 * Updates the canonical session draft. `expectedRevision` is supplied only
 * when an async send is completing; the host must reject the clear if another
 * composer has written a newer draft in the meantime.
 */
export type ChatDraftChange = (
  draft: string,
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
  const [draft, setDraft] = createSignal(props.conversation.draft)
  const [sending, setSending] = createSignal(false)
  const [mode, setMode] = createSignal<ComposerMode>(props.mode ?? 'auto')
  const [resolvedLocation, setResolvedLocation] = createSignal<string | undefined>(undefined)
  const [resolving, setResolving] = createSignal(false)
  const [resolutionStatus, setResolutionStatus] = createSignal<string>()
  let localDraftRevision = 0
  const authority = () => props.authority ?? 'chat'
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
    const objective = draft().trim()
    if (!props.decisionConsumer || !props.decisionRequest || objective.length === 0) {
      setResolutionStatus(
        'Decision layer is unavailable. Retry after the Control Plane is connected.'
      )
      return
    }
    setResolving(true)
    setResolutionStatus(undefined)
    try {
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
      const request = props.decisionRequest({ mode: mode(), objective, explicitPins })
      const outcome = await resolveAndLaunchComposer(props.decisionConsumer, request)
      if (outcome.kind === 'resolved') {
        // Which location actually runs is the resolution's answer, not the
        // user's request: show it rather than implying the pin was honoured by
        // construction (#37/#186).
        setResolvedLocation(resolvedLocationLabel(outcome.resolution))
        setResolutionStatus('Launch decision received.')
      } else setResolutionStatus(outcome.message)
    } catch (error) {
      setResolutionStatus(error instanceof Error ? error.message : 'Decision layer is unavailable.')
    } finally {
      setResolving(false)
    }
  }
  const submit = async (input: { text: string; action: 'send' | 'steer' | 'queue' }) => {
    if (input.action === 'queue') return
    const submitMode = input.action
    const text = input.text.trim()
    const deliver = submitMode === 'steer' ? props.onSteer : props.onSend
    if (disabled() || text.length === 0 || !deliver) return
    const submittedIdentity: ChatDraftIdentity = {
      runtimeSessionId: props.conversation.runtimeSessionId,
      generation: props.conversation.generation,
    }
    const submittedDraftRevision = props.draftRevision ?? 0
    const submittedLocalDraftRevision = localDraftRevision
    setSending(true)
    try {
      await deliver(text)
      if (
        props.conversation.runtimeSessionId === submittedIdentity.runtimeSessionId &&
        props.conversation.generation === submittedIdentity.generation &&
        localDraftRevision === submittedLocalDraftRevision &&
        (props.draftRevision ?? 0) === submittedDraftRevision
      ) {
        setDraft('')
        props.onDraftChange?.('', submittedIdentity, submittedDraftRevision)
      }
    } catch (error) {
      setResolutionStatus(error instanceof Error ? error.message : 'Message could not be sent.')
    } finally {
      setSending(false)
    }
  }

  return (
    <section class="dev-chat__composer" aria-label="Chat composer">
      <SharedChatComposer
        value={draft()}
        onValueChange={(nextDraft) => {
          localDraftRevision += 1
          setDraft(nextDraft)
          props.onDraftChange?.(nextDraft, {
            runtimeSessionId: props.conversation.runtimeSessionId,
            generation: props.conversation.generation,
          })
        }}
        onSubmit={submit}
        resetKey={`${props.conversation.runtimeSessionId}:${props.conversation.generation}`}
        disabled={disabledReason() !== undefined}
        readOnly={sending()}
        inputLabel="Message runtime"
        placeholder="Send a message to the runtime"
        sendableActions={{ send: typeof props.onSend === 'function' && draft().trim().length > 0 }}
        context={
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
                    onChange={(event) => customization().onModelChange?.(event.currentTarget.value)}
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
            <Show when={resolvedLocation()}>
              {(label) => (
                <p class="dev-chat__composer-location" aria-live="polite">
                  Running on {label()}
                </p>
              )}
            </Show>
            <Show when={mode() === 'customize'}>
              <p>Customize pins are submitted to the Control Plane and remain authoritative.</p>
            </Show>
            <Show when={resolutionStatus()}>{(status) => <p role="alert">{status()}</p>}</Show>
            <Show when={props.busy && steerUnavailable()}>
              <p role="status">Steer is unavailable on this host.</p>
            </Show>
          </div>
        }
        leadingActions={
          <Show when={props.decisionConsumer}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled() || resolving()}
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
              disabled={disabled() || steerUnavailable() || draft().trim().length === 0}
              onClick={() => void submit({ text: draft(), action: 'steer' })}
            >
              Steer
            </Button>
          </Show>
        }
      />
    </section>
  )
}
