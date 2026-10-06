import { ApiClientError, createApiClient } from '@adea-ai/api-client'
import { Button } from '@adea-ai/ui/components/ui/button'
import { createSignal, Match, onMount, Switch } from 'solid-js'

type AcceptStatus = 'loading' | 'ready' | 'accepting' | 'sign-in' | 'invalid' | 'joined'

/** Session-scoped hand-off so the token survives a sign-in round trip in this tab. */
const PENDING_INVITATION_KEY = 'adea:pending-workspace-invitation'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

function readPending(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_INVITATION_KEY)
  } catch {
    return null
  }
}

function writePending(token: string | null) {
  try {
    if (token) window.sessionStorage.setItem(PENDING_INVITATION_KEY, token)
    else window.sessionStorage.removeItem(PENDING_INVITATION_KEY)
  } catch {
    // Storage disabled: the link still works when opened after signing in.
  }
}

/**
 * Accepts a workspace invitation link (`/invite#token=…`). The token lives in
 * the fragment, so it never reaches the server in a URL; it is read once,
 * removed from the address bar, and sent only in the accept request's body.
 * Signing in uses the normal sign-in page and returns here.
 */
export function AcceptInvitation() {
  const client = createApiClient()
  let token: string | null = null
  const [status, setStatus] = createSignal<AcceptStatus>('loading')

  async function accept() {
    if (!token) return
    setStatus('accepting')
    try {
      const result = await client.acceptWorkspaceInvitation(token)
      writePending(null)
      setStatus('joined')
      window.location.assign(`/?workspace=${encodeURIComponent(result.workspaceId)}`)
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        setStatus('sign-in')
        return
      }
      writePending(null)
      setStatus('invalid')
    }
  }

  onMount(() => {
    const fragment =
      (window as { __ADEA_INITIAL_HASH__?: string }).__ADEA_INITIAL_HASH__ ?? window.location.hash
    const fromLink = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : '').get(
      'token'
    )
    window.history.replaceState(null, '', window.location.pathname)
    token = fromLink && TOKEN_PATTERN.test(fromLink) ? fromLink : readPending()
    if (!token || !TOKEN_PATTERN.test(token)) {
      setStatus('invalid')
      return
    }
    writePending(token)
    setStatus('ready')
  })

  return (
    <Switch>
      <Match when={status() === 'invalid'}>
        <p class="auth-eyebrow">Adea workspace</p>
        <h1 class="auth-title" id="accept-invitation-title">
          This invitation can’t be used
        </h1>
        <p class="auth-introduction" role="alert">
          It may have expired, been revoked, already been used, or been sent to a different email
          address. Ask the person who invited you for a new link.
        </p>
        <a href="/">Open Adea</a>
      </Match>
      <Match when={status() === 'sign-in'}>
        <p class="auth-eyebrow">Adea workspace</p>
        <h1 class="auth-title" id="accept-invitation-title">
          Sign in to join
        </h1>
        <p class="auth-introduction" role="status">
          Sign in with the email address the invitation was sent to, then you’ll come back here to
          accept it.
        </p>
        <a href={`/auth/sign-in?returnTo=${encodeURIComponent('/invite')}`}>Sign in</a>
      </Match>
      <Match when={status() === 'joined'}>
        <p class="auth-eyebrow">Adea workspace</p>
        <h1 class="auth-title" id="accept-invitation-title">
          You’ve joined the workspace
        </h1>
        <p class="auth-introduction" role="status" aria-live="polite">
          Opening it now…
        </p>
      </Match>
      <Match when={status() === 'loading' || status() === 'ready' || status() === 'accepting'}>
        <p class="auth-eyebrow">Adea workspace</p>
        <h1 class="auth-title" id="accept-invitation-title">
          You’ve been invited to a workspace
        </h1>
        <p class="auth-introduction">
          Accepting adds you as a member with the role you were invited with.
        </p>
        <Button
          type="button"
          disabled={status() !== 'ready'}
          aria-busy={status() === 'accepting'}
          onClick={() => void accept()}
        >
          {status() === 'accepting' ? 'Joining…' : 'Accept invitation'}
        </Button>
      </Match>
    </Switch>
  )
}
