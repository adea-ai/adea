'use client'

import { Check, ExternalLink } from 'lucide-solid'
import { createSignal, Match, onMount, Switch } from 'solid-js'

import { parseDesktopCallbackFragment } from '../lib/desktop-auth-navigation'

type CompletionStatus = 'opening' | 'opened' | 'invalid' | 'early_access'

export function DesktopAuthComplete() {
  let callbackUrl: string | null = null
  const [status, setStatus] = createSignal<CompletionStatus>('opening')

  function openDesktopApp() {
    if (!callbackUrl) return
    window.location.assign(callbackUrl)
    setStatus('opened')
  }

  // Client-only: the callback fragment, the history cleanup, and the
  // `adea://` handoff all need the browser. A server render shows the
  // in-progress state until hydration runs this.
  onMount(() => {
    const fragment = window.location.hash
    const errorParams = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : '')
    if (errorParams.get('error') === 'early_access') {
      // Return the app to a recoverable state: the pending attempt fails
      // cleanly and the start screen offers sign-in again.
      callbackUrl = 'adea://auth/callback?error=early_access'
      openDesktopApp()
      setStatus('early_access')
      return
    }

    callbackUrl = parseDesktopCallbackFragment(fragment)
    window.history.replaceState(null, '', window.location.pathname)
    if (!callbackUrl) {
      setStatus('invalid')
      return
    }
    openDesktopApp()
  })

  return (
    <Switch>
      <Match when={status() === 'early_access'}>
        <p class="auth-eyebrow">Adea desktop</p>
        <h1 class="auth-title" id="desktop-auth-complete-title">
          Adea is in early access
        </h1>
        <p class="auth-introduction" role="status">
          Please reach out on github if you&apos;d like to contribute.
        </p>
        <a
          class="browser-auth-submit browser-auth-open-app"
          href="https://github.com/adea-ai/adea"
          target="_blank"
          rel="noreferrer"
        >
          Adea on GitHub
          <ExternalLink aria-hidden="true" />
        </a>
      </Match>
      <Match when={status() === 'invalid'}>
        <p class="auth-eyebrow">Adea desktop</p>
        <h1 class="auth-title" id="desktop-auth-complete-title">
          Return link expired
        </h1>
        <p class="auth-introduction" role="alert">
          Start sign-in again from the Adea desktop app to generate a new secure return link.
        </p>
      </Match>
      <Match when={status() !== 'early_access' && status() !== 'invalid'}>
        <span class="browser-auth-success-mark" aria-hidden="true">
          <Check />
        </span>
        <p class="auth-eyebrow">Sign-in successful</p>
        <h1 class="auth-title" id="desktop-auth-complete-title">
          You’re all set
        </h1>
        <p class="auth-introduction" role="status" aria-live="polite">
          Adea {status() === 'opening' ? 'is opening' : 'has been opened'}. You can close this tab
          and continue in the desktop app.
        </p>
        <button
          class="browser-auth-submit browser-auth-open-app"
          type="button"
          onClick={openDesktopApp}
        >
          Open Adea
          <ExternalLink aria-hidden="true" />
        </button>
      </Match>
    </Switch>
  )
}
