'use client'

import { useState, type FormEvent } from 'react'

type AuthMode = 'sign-in' | 'sign-up'

/**
 * Maps a provider failure to copy the person can act on. The provider's own
 * message is never shown, so unknown causes fall back to a generic line.
 * @param code normalized provider error code, when one is available
 * @param mode the form mode that failed
 */
function messageForFailure(code: string | null, mode: AuthMode): string {
  switch (code) {
    case 'invalid_credentials':
      return mode === 'sign-up'
        ? 'That email is already registered. Sign in instead, or use a different address.'
        : 'That email and password combination did not match. Check both and try again.'
    case 'email_not_confirmed':
      return 'Confirm your email address first — check your inbox for the verification message.'
    case 'user_already_exists':
    case 'user_already_exists_use_another_email':
    case 'email_exists':
      return 'An account already exists for that email. Sign in instead.'
    case 'weak_password':
      return 'Choose a longer password. Adea requires at least eight characters.'
    case 'email_address_invalid':
      return 'That email address does not look valid. Check it and try again.'
    case 'over_request_rate_limit':
      return 'Too many attempts. Wait a moment, then try again.'
    case 'session_expired':
    case 'session_not_found':
      return 'Your sign-in session expired before it finished. Try again.'
    case 'validation_failed':
      // The provider's "already registered" code is normalized to this one, so
      // name the likely cause without asserting it.
      return mode === 'sign-up'
        ? 'Check the details and try again. If that email is already registered, sign in instead.'
        : 'Check the details and try again.'
    default:
      return mode === 'sign-up'
        ? 'Adea could not create that account. Check the details or sign in instead.'
        : 'Adea could not sign you in. Check your email and password, then try again.'
  }
}

export function SignInForm({ returnTo }: { returnTo: string }) {
  const [mode, setMode] = useState<AuthMode>('sign-in')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setPending(true)
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email') ?? '').trim()
    const password = String(data.get('password') ?? '')
    // Imported before the request so the failure mapper is available in catch.
    const { authErrorCode, createNeonClientAdapter } = await import('@adea-ai/auth/client')

    try {
      const authentication = createNeonClientAdapter()
      if (mode === 'sign-up') {
        await authentication.signUp({
          email,
          name: String(data.get('name') ?? '').trim(),
          password,
        })
      } else {
        await authentication.signIn({ email, password })
      }
      window.location.assign(returnTo)
    } catch (failure) {
      setError(messageForFailure(authErrorCode(failure), mode))
      setPending(false)
    }
  }

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode)
    setError('')
  }

  return (
    <>
      <div className="browser-auth-mode" aria-label="Choose authentication mode">
        <button
          type="button"
          aria-pressed={mode === 'sign-in'}
          onClick={() => changeMode('sign-in')}
        >
          Sign in
        </button>
        <button
          type="button"
          aria-pressed={mode === 'sign-up'}
          onClick={() => changeMode('sign-up')}
        >
          Create account
        </button>
      </div>

      <form className="browser-auth-form" onSubmit={submit}>
        {mode === 'sign-up' ? (
          <label htmlFor="name">
            Display name
            <input id="name" name="name" autoComplete="name" required disabled={pending} />
          </label>
        ) : null}

        <label htmlFor="email">
          Email
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            disabled={pending}
          />
        </label>

        <label htmlFor="password">
          Password
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            minLength={8}
            required
            disabled={pending}
          />
        </label>

        <p className="browser-auth-error" role="status" aria-live="polite">
          {error}
        </p>

        <button className="browser-auth-submit" type="submit" disabled={pending}>
          {pending
            ? mode === 'sign-up'
              ? 'Creating account…'
              : 'Signing in…'
            : mode === 'sign-up'
              ? 'Create account and continue'
              : 'Sign in and continue'}
        </button>
      </form>
    </>
  )
}
