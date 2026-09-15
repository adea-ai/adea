import type { Scope } from '@adea-ai/types/dev-runtime'
import type { QueryClient } from '@tanstack/solid-query'

const root = ['dev-runtime'] as const

function scopeKey(scope: Scope) {
  return [...root, scope.accountId, scope.workspaceId, scope.runtimeNodeId] as const
}

/**
 * Hierarchical private-cache keys. The authority scope always precedes an
 * entity ID so a node/workspace can be cancelled and removed as one prefix.
 */
export const devRuntimeQueryKeys = Object.freeze({
  all: root,
  node: (scope: Scope) => scopeKey(scope),
  projects: (scope: Scope) => [...scopeKey(scope), 'projects'] as const,
  project: (scope: Scope, projectId: string) =>
    [...scopeKey(scope), 'projects', projectId] as const,
  sessions: (scope: Scope, projectId?: string) =>
    [...scopeKey(scope), 'sessions', ...(projectId ? [projectId] : [])] as const,
  session: (scope: Scope, runtimeSessionId: string) =>
    [...scopeKey(scope), 'sessions', runtimeSessionId] as const,
  capabilities: (scope: Scope) => [...scopeKey(scope), 'capabilities'] as const,
})

/** Cancel before removal so an outgoing request cannot repopulate private data. */
export async function releaseDevRuntimeNodeCache(queryClient: QueryClient, scope: Scope) {
  const queryKey = devRuntimeQueryKeys.node(scope)
  await queryClient.cancelQueries({ queryKey })
  queryClient.removeQueries({ queryKey })
}

/** Releases all runtime-node data for exactly one account/workspace pair. */
export async function releaseDevRuntimeWorkspaceCache(
  queryClient: QueryClient,
  accountId: string,
  workspaceId: string
) {
  if (!accountId || !workspaceId) return
  const queryKey = [...root, accountId, workspaceId] as const
  await queryClient.cancelQueries({ queryKey })
  queryClient.removeQueries({ queryKey })
}
