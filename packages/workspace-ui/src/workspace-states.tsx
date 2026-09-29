import { AlertTriangle, Inbox, RefreshCw } from 'lucide-solid'
import { For, Show, type JSX } from 'solid-js'
import { ApiClientError } from '@adea-ai/api-client'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@adea-ai/ui/components/ui/empty'
import { Skeleton } from '@adea-ai/ui/components/ui/skeleton'

export function WorkspaceSkeleton(props: { label?: string }) {
  return (
    <div
      class="conventional-skeleton"
      aria-busy="true"
      aria-label={props.label ?? 'Loading workspace'}
    >
      <For each={Array.from({ length: 6 })}>
        {() => <Skeleton class="conventional-skeleton__bar" />}
      </For>
    </div>
  )
}

export function WorkspaceEmpty(props: { action?: JSX.Element; detail: string; title: string }) {
  return (
    <Empty role="region" aria-labelledby="workspace-empty-title">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.detail}</EmptyDescription>
      </EmptyHeader>
      <Show when={props.action}>{props.action}</Show>
    </Empty>
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
