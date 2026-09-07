'use client'

import { Check, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { parseDesktopCallbackFragment } from '../../../../lib/desktop-auth-navigation'

type CompletionStatus = 'opening' | 'opened' | 'invalid' | 'early_access'

export function DesktopAuthComplete() {
  const callbackRef = useRef<string | null>(null)
  const attemptedRef = useRef(false)
  const [status, setStatus] = useState<CompletionStatus>('opening')

  function openDesktopApp() {
    if (!callbackRef.current) return
    window.location.assign(callbackRef.current)
    setStatus('opened')
  }

  useEffect(() => {
    if (attemptedRef.current) return
    attemptedRef.current = true

    const fragment = window.location.hash
    const errorParams = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : '')
    if (errorParams.get('error') === 'early_access') {
      // Return the app to a recoverable state: the pending attempt fails
      // cleanly and the start screen offers sign-in again.
      callbackRef.current = 'adea://auth/callback?error=early_access'
      openDesktopApp()
      setStatus('early_access')
      return
    }

    callbackRef.current = parseDesktopCallbackFragment(window.location.hash)
    window.history.replaceState(null, '', window.location.pathname)
    if (!callbackRef.current) {
      setStatus('invalid')
      return
    }
    openDesktopApp()
  }, [])

  if (status === 'early_access') {
    return (
      <>
        <p className="auth-eyebrow">Adea desktop</p>
        <h1 className="auth-title" id="desktop-auth-complete-title">
          Adea is in early access
        </h1>
        <p className="auth-introduction" role="status">
          Please reach out on github if you&apos;d like to contribute.
        </p>
        <a
          className="browser-auth-submit browser-auth-open-app"
          href="https://github.com/adea-ai/adea"
          target="_blank"
          rel="noreferrer"
        >
          Adea on GitHub
          <ExternalLink aria-hidden="true" />
        </a>
      </>
    )
  }

  if (status === 'invalid') {
    return (
      <>
        <p className="auth-eyebrow">Adea desktop</p>
        <h1 className="auth-title" id="desktop-auth-complete-title">
          Return link expired
        </h1>
        <p className="auth-introduction" role="alert">
          Start sign-in again from the Adea desktop app to generate a new secure return link.
        </p>
      </>
    )
  }

  return (
    <>
      <span className="browser-auth-success-mark" aria-hidden="true">
        <Check />
      </span>
      <p className="auth-eyebrow">Sign-in successful</p>
      <h1 className="auth-title" id="desktop-auth-complete-title">
        You’re all set
      </h1>
      <p className="auth-introduction" role="status" aria-live="polite">
        Adea {status === 'opening' ? 'is opening' : 'has been opened'}. You can close this tab and
        continue in the desktop app.
      </p>
      <button
        className="browser-auth-submit browser-auth-open-app"
        type="button"
        onClick={openDesktopApp}
      >
        Open Adea
        <ExternalLink aria-hidden="true" />
      </button>
    </>
  )
}
