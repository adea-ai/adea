import {
  ApiClientError,
  createApiClient,
  type ApiWorkspaceInvitationPreviewResponse,
} from '@adea-ai/api-client'
import { useAcceptWorkspaceInvitationMutation } from '@adea-ai/data'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Heading } from '@adea-ai/ui/components/ui/typography'
import { createSignal, Match, onMount, Show, Switch } from 'solid-js'

import { describeInvitationContext, invitationRoleLabel } from '../lib/workspace-invitation-preview'

type AcceptStatus =
  | 'loading'
  | 'ready'
  | 'accepting'
  | 'sign-in'
  | 'invalid'
  | 'unavailable'
  | 'joined'

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
 * removed from the address bar, and sent only in request bodies. The page
 * first previews the invitation, so the invitee sees the workspace, its owner,
 * its audience and their role before joining; the preview has the acceptance
 * gates, so a guest is sent to sign in before they are shown anything.
 * Signing in uses the normal sign-in page and returns here. Render it inside a
 * query provider: accepting goes through the shared sharing mutation, which
 * refreshes the workspace list.
 */
export function AcceptInvitation() {
  const client = createApiClient()
  const acceptInvitation = useAcceptWorkspaceInvitationMutation(client)
  let token: string | null = null
  const [status, setStatus] = createSignal<AcceptStatus>('loading')
  const [preview, setPreview] = createSignal<ApiWorkspaceInvitationPreviewResponse>()

  async function loadPreview() {
    if (!token) return
    setStatus('loading')
    try {
      setPreview(await client.previewWorkspaceInvitation(token))
      setStatus('ready')
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) setStatus('sign-in')
      else if (error instanceof ApiClientError && error.status < 500) {
        writePending(null)
        setStatus('invalid')
      } else setStatus('unavailable')
    }
  }

  async function accept() {
    if (!token) return
    setStatus('accepting')
    try {
      const result = await acceptInvitation.mutateAsync(token)
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
    void loadPreview()
  })

  return (
    <Switch>
      <Match when={status() === 'invalid'}>
        <p class="auth-eyebrow">Adea workspace</p>
        <Heading as="h1" size="display" data-auth-title id="accept-invitation-title">
          This invitation can’t be used
        </Heading>
        <p class="auth-introduction" role="alert">
          It may have expired, been revoked, already been used, or been sent to a different email
          address. Ask the person who invited you for a new link.
        </p>
        <a href="/">Open Adea</a>
      </Match>
      <Match when={status() === 'unavailable'}>
        <p class="auth-eyebrow">Adea workspace</p>
        <Heading as="h1" size="display" data-auth-title id="accept-invitation-title">
          This invitation could not be checked
        </Heading>
        <p class="auth-introduction" role="alert">
          Adea could not reach the invitation just now. Nothing was joined. Try again.
        </p>
        <Button type="button" onClick={() => void loadPreview()}>
          Try again
        </Button>
      </Match>
      <Match when={status() === 'sign-in'}>
        <p class="auth-eyebrow">Adea workspace</p>
        <Heading as="h1" size="display" data-auth-title id="accept-invitation-title">
          Sign in to join
        </Heading>
        <p class="auth-introduction" role="status">
          Sign in with the email address the invitation was sent to, then you’ll come back here to
          accept it.
        </p>
        <a href={`/auth/sign-in?returnTo=${encodeURIComponent('/invite')}`}>Sign in</a>
      </Match>
      <Match when={status() === 'joined'}>
        <p class="auth-eyebrow">Adea workspace</p>
        <Heading as="h1" size="display" data-auth-title id="accept-invitation-title">
          You’ve joined the workspace
        </Heading>
        <p class="auth-introduction" role="status" aria-live="polite">
          Opening it now…
        </p>
      </Match>
      <Match when={status() === 'loading' || status() === 'ready' || status() === 'accepting'}>
        <p class="auth-eyebrow">Adea workspace</p>
        <Show
          when={preview()}
          fallback={
            <>
              <Heading as="h1" size="display" data-auth-title id="accept-invitation-title">
                You’ve been invited to a workspace
              </Heading>
              <p class="auth-introduction" role="status">
                Checking the invitation…
              </p>
            </>
          }
        >
          {(shown) => (
            <>
              <Heading as="h1" size="display" data-auth-title id="accept-invitation-title">
                You’ve been invited to {shown().workspaceName}
              </Heading>
              <p class="auth-introduction" data-testid="invitation-context">
                {describeInvitationContext(shown())}
              </p>
              <p class="auth-introduction">
                Accepting adds you as {invitationRoleLabel(shown().role)}. The workspace’s members
                will see you in its member list.
              </p>
            </>
          )}
        </Show>
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
