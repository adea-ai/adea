import { AlertTriangle, Inbox, RefreshCw } from 'lucide-solid'
import { For, Show, type JSX } from 'solid-js'
import { ApiClientError } from '@adea-ai/api-client'

export function WorkspaceSkeleton(props: { label?: string }) {
  return (
    <div
      class="conventional-skeleton"
      aria-busy="true"
      aria-label={props.label ?? 'Loading workspace'}
    >
      <For each={Array.from({ length: 6 })}>{() => <span />}</For>
    </div>
  )
}

export function WorkspaceEmpty(props: { action?: JSX.Element; detail: string; title: string }) {
  return (
    <section class="conventional-empty" aria-labelledby="workspace-empty-title">
      <Inbox aria-hidden="true" />
      <h2 id="workspace-empty-title">{props.title}</h2>
      <p>{props.detail}</p>
      {props.action}
    </section>
  )
}

function errorCopy(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return 'Your session expired. Sign in again to continue.'
    if (error.status === 403) return 'You do not have permission to use this workspace.'
    if (error.status === 404) return 'This workspace item is no longer available.'
    if (error.status === 409) return 'This changed elsewhere. Reload the latest version and retry.'
    if (error.status === 400) return 'The request was not valid. Check the fields and try again.'
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine)
    return 'You appear to be offline. Your draft is safe on this device.'
  return 'Adea could not load this content. Your durable workspace was not changed.'
}

export function WorkspaceError(props: { error: unknown; retry?: () => void }) {
  return (
    <section class="conventional-error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <h2>Something interrupted the workspace</h2>
        <p>{errorCopy(props.error)}</p>
      </div>
      <Show when={props.retry}>
        {(retry) => (
          <button type="button" class="conventional-secondary-button" onClick={() => retry()()}>
            <RefreshCw aria-hidden="true" />
            Retry
          </button>
        )}
      </Show>
    </section>
  )
}
