import type { AgentHqApiClient } from '@adea-ai/api-client'
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/solid-query'
import { projectQueryKeys } from './project-query-keys'

export const projectRestoreMutationOptions = {
  restore: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (variables: {
      input: Parameters<AgentHqApiClient['restoreProject']>[2]
      projectId: string
    }) => client.restoreProject(workspaceId, variables.projectId, variables.input),
    onSuccess: async (
      result: Awaited<ReturnType<AgentHqApiClient['restoreProject']>>,
      variables: { projectId: string }
    ) => {
      queryClient.setQueryData(projectQueryKeys.detail(workspaceId, variables.projectId), result)
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.all(workspaceId) })
    },
  }),
}

export function useRestoreProjectMutation(
  client: AgentHqApiClient,
  workspaceId: string | (() => string)
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    projectRestoreMutationOptions.restore(
      client,
      queryClient,
      typeof workspaceId === 'function' ? workspaceId() : workspaceId
    )
  )
}
