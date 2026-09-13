import { workspaceStore } from '@adea-ai/state'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/solid-query'
import { createEffect, onCleanup, type ParentProps } from 'solid-js'

import { createWorkspaceEventSubscription } from './events'

/** A value that may be supplied as a Solid accessor so subscriptions stay reactive. */
type MaybeAccessor<T> = T | (() => T)

function resolveAccessor<T>(value: MaybeAccessor<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

/**
 * Releases every cached query and in-flight request belonging to one workspace.
 * Workspaces are fully isolated contexts, so leaving one must drop its data
 * instead of keeping it resident until the garbage-collection window closes.
 * User-scoped entries (bootstrap, workspace list) live outside this key and
 * survive the release.
 */
export function releaseWorkspaceCache(queryClient: QueryClient, workspaceId: string) {
  if (!workspaceId) return
  void queryClient.cancelQueries({ queryKey: ['workspaces', workspaceId] })
  queryClient.removeQueries({ queryKey: ['workspaces', workspaceId] })
}

export function AgentHqQueryProvider(props: ParentProps) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  })
  let previousWorkspaceId: string | null = null

  createEffect(() => {
    const selectedWorkspaceId = workspaceStore.getState().selectedWorkspaceId
    if (previousWorkspaceId && selectedWorkspaceId && previousWorkspaceId !== selectedWorkspaceId) {
      releaseWorkspaceCache(queryClient, previousWorkspaceId)
    }
    previousWorkspaceId = selectedWorkspaceId
  })

  onCleanup(() => queryClient.clear())

  return <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>
}

/**
 * Keeps the cache current from the durable workspace event stream while a
 * workspace is open, and drops the subscription when it closes or changes. The
 * subscription owns reconnection, cursor persistence, and gap recovery; this
 * hook only decides when it should exist.
 */
export function useWorkspaceEventStream(
  options: Readonly<{
    workspaceId: MaybeAccessor<string | undefined>
    url: MaybeAccessor<string | undefined>
    headers?: () => Record<string, string>
  }>
) {
  const queryClient = useQueryClient()

  // Callers build the header callback inline; reading it through the options
  // object keeps the subscription identity tied to the workspace rather than to
  // a render.
  createEffect(() => {
    const workspaceId = resolveAccessor(options.workspaceId)
    const url = resolveAccessor(options.url)
    if (!workspaceId || !url) return
    const subscription = createWorkspaceEventSubscription({
      headers: () => options.headers?.() ?? {},
      queryClient,
      url,
      workspaceId,
    })
    onCleanup(() => subscription.stop())
  })
}
