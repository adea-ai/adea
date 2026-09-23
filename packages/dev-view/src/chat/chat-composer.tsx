import { createSignal, Show, type JSX } from 'solid-js'

import type { ChatConversation } from './model'
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

export type ChatComposerProps = Readonly<{
  conversation: ChatConversation
  authority?: ChatInputAuthority
  connected?: boolean
  awaitingApproval?: boolean
  busy?: boolean
  onSend?: (text: string) => void | Promise<void>
  onSteer?: (text: string) => void | Promise<void>
  onStop?: () => void | Promise<void>
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

export function chatComposerDisabledReason(props: {
  conversation: ChatConversation
  authority: ChatInputAuthority
  connected: boolean
  awaitingApproval: boolean
}): string | undefined {
  if (props.conversation.archived) return 'This conversation is archived.'
  if (!['active', 'ready'].includes(props.conversation.status))
    return `Chat is unavailable while the runtime is ${props.conversation.status}.`
  if (props.authority !== 'chat') return 'Chat input is owned by the active runtime.'
  if (props.awaitingApproval) return 'Waiting for approval before sending input.'
  if (!props.connected) return 'Runtime disconnected. Reconnect the transcript to continue.'
  return undefined
}

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const [draft, setDraft] = createSignal(props.conversation.draft)
  const [sending, setSending] = createSignal(false)
  const [mode, setMode] = createSignal<ComposerMode>(props.mode ?? 'auto')
  const [resolvedLocation, setResolvedLocation] = createSignal<string | undefined>(undefined)
  const [resolving, setResolving] = createSignal(false)
  const [resolutionStatus, setResolutionStatus] = createSignal<string>()
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
  const submit = async (submitMode: 'send' | 'steer', event: Event) => {
    event.preventDefault()
    const text = draft().trim()
    if (disabled() || text.length === 0) return
    setSending(true)
    try {
      if (submitMode === 'steer') await props.onSteer?.(text)
      else await props.onSend?.(text)
      setDraft('')
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      class="dev-chat__composer"
      aria-label="Chat composer"
      onSubmit={(event) => submit('send', event)}
    >
      <label for="dev-chat-composer-input">Message runtime</label>
      <div class="dev-chat__composer-controls" aria-label="Launch mode">
        <label for="dev-chat-composer-agent">Agent</label>
        <Show
          when={props.agentProfiles && props.agentProfiles.length > 0}
          fallback={<span>{props.agentProfile?.label ?? 'Select an agent profile'}</span>}
        >
          <select
            id="dev-chat-composer-agent"
            value={props.agentProfile?.id ?? ''}
            onChange={(event) => props.onAgentProfileChange?.(event.currentTarget.value)}
          >
            <option value="">Select an agent profile</option>
            {props.agentProfiles?.map((profile) => (
              <option value={profile.id}>{profile.label}</option>
            ))}
          </select>
        </Show>
        <label for="dev-chat-composer-mode">Mode</label>
        <select
          id="dev-chat-composer-mode"
          value={mode()}
          onChange={(event) => selectMode(event.currentTarget.value as ComposerMode)}
        >
          <option value="auto">Auto</option>
          <option value="customize">Customize</option>
        </select>
      </div>
      <Show when={mode() === 'customize' && props.customization}>
        {(customization) => (
          <div class="dev-chat__composer-controls" aria-label="Customize launch pins">
            <label for="dev-chat-composer-harness">Harness</label>
            <select
              id="dev-chat-composer-harness"
              value={customization().harnessId ?? ''}
              onChange={(event) => customization().onHarnessChange?.(event.currentTarget.value)}
            >
              <option value="">Control Plane default</option>
              {customization().harnessOptions.map((option) => (
                <option value={option.id}>{option.label}</option>
              ))}
            </select>
            <label for="dev-chat-composer-model">Model</label>
            <select
              id="dev-chat-composer-model"
              value={customization().modelId ?? ''}
              onChange={(event) => customization().onModelChange?.(event.currentTarget.value)}
            >
              <option value="">Control Plane default</option>
              {customization().modelOptions.map((option) => (
                <option value={option.id}>{option.label}</option>
              ))}
            </select>
            <Show when={(customization().runtimeOptions ?? []).length > 0}>
              <label for="dev-chat-composer-runtime">Location</label>
              <select
                id="dev-chat-composer-runtime"
                value={customization().runtimeDefinitionId ?? ''}
                onChange={(event) => customization().onRuntimeChange?.(event.currentTarget.value)}
              >
                <option value="">Control Plane default</option>
                {(customization().runtimeOptions ?? []).map((option) => (
                  <option value={option.id}>{option.label}</option>
                ))}
              </select>
            </Show>
          </div>
        )}
      </Show>
      <textarea
        id="dev-chat-composer-input"
        value={draft()}
        disabled={disabled()}
        aria-describedby="dev-chat-composer-status"
        placeholder="Send a message to the runtime"
        onInput={(event) => setDraft(event.currentTarget.value)}
      />
      <p id="dev-chat-composer-status" role="status">
        <Show when={disabledReason()} fallback="Input is sent with the current runtime generation.">
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
      <div class="dev-chat__composer-actions">
        <Show when={props.decisionConsumer}>
          <button
            type="button"
            class="dev-button"
            disabled={disabled() || resolving()}
            onClick={() => void resolve()}
          >
            {resolving() ? 'Resolving…' : 'Resolve & launch'}
          </button>
        </Show>
        <Show when={props.busy}>
          <button type="button" class="dev-button" onClick={() => props.onStop?.()}>
            Stop
          </button>
          <button
            type="button"
            class="dev-button"
            disabled={disabled()}
            onClick={(event) => void submit('steer', event)}
          >
            Steer
          </button>
        </Show>
        <button type="submit" class="dev-button" disabled={disabled()}>
          {sending() ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  )
}
