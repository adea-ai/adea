'use client'

import { useWorkspaceStore } from '@adea-ai/state'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { createWorkspaceEventSubscription } from './events'

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

export function AgentHqQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      })
  )
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId)
  const previousWorkspaceIdRef = useRef<string | null>(null)

  useEffect(() => {
    const previousWorkspaceId = previousWorkspaceIdRef.current
    previousWorkspaceIdRef.current = selectedWorkspaceId
    if (previousWorkspaceId && selectedWorkspaceId && previousWorkspaceId !== selectedWorkspaceId)
      releaseWorkspaceCache(queryClient, previousWorkspaceId)
  }, [queryClient, selectedWorkspaceId])

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

/**
 * Keeps the cache current from the durable workspace event stream while a
 * workspace is open, and drops the subscription when it closes or changes. The
 * subscription owns reconnection, cursor persistence, and gap recovery; this
 * hook only decides when it should exist.
 */
export function useWorkspaceEventStream(
  options: Readonly<{
    workspaceId: string | undefined
    url: string | undefined
    headers?: () => Record<string, string>
  }>
) {
  const queryClient = useQueryClient()
  const { headers, url, workspaceId } = options
  // Callers build the header callback inline; holding it in a ref keeps the
  // subscription identity tied to the workspace rather than to a render.
  const headersRef = useRef(headers)
  headersRef.current = headers
  useEffect(() => {
    if (!workspaceId || !url) return
    const subscription = createWorkspaceEventSubscription({
      headers: () => headersRef.current?.() ?? {},
      queryClient,
      url,
      workspaceId,
    })
    return () => subscription.stop()
  }, [queryClient, url, workspaceId])
}
