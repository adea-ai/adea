import { For, Show, createMemo, createSignal, type JSX } from 'solid-js'

import type {
  FirstRunActionKind,
  FirstRunFacts,
  FirstRunManagedPi,
  FirstRunConversation,
} from './index'
import { createFirstRunController, projectFirstRun } from './index'
import { ChatRuntimeError } from '../model/commands'
import './onboarding.css'

export type FirstRunOnboardingProps = Readonly<{
  facts: FirstRunFacts
  port: Readonly<{
    installManagedPi(): Promise<FirstRunManagedPi>
    createConversation(request: {
      prompt: string
      idempotencyKey: string
    }): Promise<FirstRunConversation>
  }>
  onAction(kind: Exclude<FirstRunActionKind, 'retry_install' | 'start'>): void | Promise<void>
  onManagedPiChange?(status: FirstRunManagedPi): void
  onConversation(conversation: FirstRunConversation): void
}>

/** The first-run surface consumes entitlement and identity truth from its
 * owner. It exposes no harness, model, or runtime configuration controls. */
export function FirstRunOnboarding(props: FirstRunOnboardingProps): JSX.Element {
  const [prompt, setPrompt] = createSignal('')
  const [managedPi, setManagedPi] = createSignal<FirstRunManagedPi | undefined>()
  const [authRequired, setAuthRequired] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [notice, setNotice] = createSignal<string>()
  const facts = createMemo<FirstRunFacts>(() => ({
    ...props.facts,
    identity: authRequired() ? 'auth_required' : props.facts.identity,
    managedPi: managedPi() ?? props.facts.managedPi,
  }))
  const state = createMemo(() => projectFirstRun(facts()))
  const controller = createFirstRunController({
    createConversation: (request) => props.port.createConversation(request),
  })

  const act = async (kind: FirstRunActionKind) => {
    if (pending()) return
    setNotice(undefined)
    if (kind === 'retry_install') {
      setPending(true)
      try {
        const status = await props.port.installManagedPi()
        setManagedPi(status)
        props.onManagedPiChange?.(status)
      } catch (error) {
        setManagedPi({
          state: 'failed',
          code: error instanceof ChatRuntimeError ? error.code : 'unavailable',
        })
      } finally {
        setPending(false)
      }
      return
    }
    if (kind === 'start') {
      setPending(true)
      try {
        props.onConversation(await controller.start(prompt(), facts()))
      } catch (error) {
        if (error instanceof ChatRuntimeError && error.code === 'auth_required')
          setAuthRequired(true)
        else setNotice('The conversation could not start. Try again with the same message.')
      } finally {
        setPending(false)
      }
      return
    }
    setPending(true)
    try {
      await props.onAction(kind)
      if (kind === 'sign_in') setAuthRequired(false)
    } catch {
      setNotice('That step could not complete. Try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <main class="dev-onboarding" aria-busy={pending() || state().busy}>
      <section class="dev-onboarding__panel" aria-labelledby="dev-onboarding-title">
        <p class="dev-onboarding__eyebrow">Adea chat</p>
        <h1 id="dev-onboarding-title">{state().heading}</h1>
        <p class="dev-onboarding__message">{state().message}</p>
        <p class="dev-onboarding__install" role="status" aria-live="polite">
          {state().installStatus}
        </p>
        <Show when={state().stage === 'compose'}>
          <label class="dev-onboarding__label" for="dev-onboarding-prompt">
            Your first message
          </label>
          <textarea
            id="dev-onboarding-prompt"
            class="dev-onboarding__prompt"
            value={prompt()}
            onInput={(event) => setPrompt(event.currentTarget.value)}
            placeholder="What would you like help with?"
            disabled={pending()}
          />
        </Show>
        <div class="dev-onboarding__actions">
          <For each={state().actions}>
            {(action) => (
              <button
                type="button"
                class="dev-button"
                disabled={pending() || (action.kind === 'start' && !prompt().trim())}
                onClick={() => void act(action.kind)}
              >
                {action.label}
              </button>
            )}
          </For>
        </div>
        <Show when={notice()}>
          <p class="dev-onboarding__notice" role="alert">
            {notice()}
          </p>
        </Show>
      </section>
    </main>
  )
}
