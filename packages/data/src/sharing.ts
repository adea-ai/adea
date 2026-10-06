import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { ProjectMemberRole, ProjectVisibility } from '@adea-ai/types'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/solid-query'

/**
 * Sharing queries (ADR 0012): workspace members, invitations, project
 * visibility and project members. Keys sit under the workspace prefix, so the
 * `workspace.*` and `project.*` event families refresh them.
 */
export const sharingQueryKeys = {
  invitations: (workspaceId: string) => ['workspaces', workspaceId, 'invitations'] as const,
  projectMembers: (workspaceId: string, projectId: string) =>
    ['workspaces', workspaceId, 'projects', 'members', projectId] as const,
  workspaceMembers: (workspaceId: string) => ['workspaces', workspaceId, 'members'] as const,
}

export const sharingQueryOptions = {
  invitations: (client: AgentHqApiClient, workspaceId?: string, enabled = true) => ({
    enabled: Boolean(workspaceId) && enabled,
    queryFn: () => client.listWorkspaceInvitations(workspaceId!),
    queryKey: sharingQueryKeys.invitations(workspaceId ?? ''),
  }),
  projectMembers: (client: AgentHqApiClient, workspaceId?: string, projectId?: string) => ({
    enabled: Boolean(workspaceId && projectId),
    queryFn: () => client.listProjectMembers(workspaceId!, projectId!),
    queryKey: sharingQueryKeys.projectMembers(workspaceId ?? '', projectId ?? ''),
  }),
  workspaceMembers: (client: AgentHqApiClient, workspaceId?: string) => ({
    enabled: Boolean(workspaceId),
    queryFn: () => client.listWorkspaceMembers(workspaceId!),
    queryKey: sharingQueryKeys.workspaceMembers(workspaceId ?? ''),
  }),
}

export const sharingMutationOptions = {
  acceptInvitation: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (token: string) => client.acceptWorkspaceInvitation(token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces', 'list'] })
    },
  }),
  createInvitation: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createWorkspaceInvitation']>[1]) =>
      client.createWorkspaceInvitation(workspaceId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sharingQueryKeys.invitations(workspaceId) })
    },
  }),
  removeProjectMember: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string,
    projectId: string
  ) => ({
    mutationFn: (userId: string) => client.removeProjectMember(workspaceId, projectId, userId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: sharingQueryKeys.projectMembers(workspaceId, projectId),
      })
    },
  }),
  revokeInvitation: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (invitationId: string) =>
      client.revokeWorkspaceInvitation(workspaceId, invitationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sharingQueryKeys.invitations(workspaceId) })
    },
  }),
  setProjectMember: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string,
    projectId: string
  ) => ({
    mutationFn: (input: Readonly<{ role: ProjectMemberRole; userId: string }>) =>
      client.setProjectMember(workspaceId, projectId, input.userId, input.role),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: sharingQueryKeys.projectMembers(workspaceId, projectId),
      })
    },
  }),
  setProjectVisibility: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string,
    projectId: string
  ) => ({
    mutationFn: (visibility: ProjectVisibility) =>
      client.setProjectVisibility(workspaceId, projectId, visibility),
    onSuccess: async () => {
      // Visibility decides who sees the project's channels, tasks and read
      // state, so the whole workspace scope refreshes.
      await queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] })
    },
  }),
}

type Accessor<T> = () => T

export function useWorkspaceMembersQuery(
  client: AgentHqApiClient,
  workspaceId: Accessor<string | undefined>
) {
  return useQuery(() => sharingQueryOptions.workspaceMembers(client, workspaceId()))
}

export function useWorkspaceInvitationsQuery(
  client: AgentHqApiClient,
  workspaceId: Accessor<string | undefined>,
  enabled: Accessor<boolean> = () => true
) {
  return useQuery(() => sharingQueryOptions.invitations(client, workspaceId(), enabled()))
}

export function useProjectMembersQuery(
  client: AgentHqApiClient,
  workspaceId: Accessor<string | undefined>,
  projectId: Accessor<string | undefined>
) {
  return useQuery(() => sharingQueryOptions.projectMembers(client, workspaceId(), projectId()))
}

export function useSetProjectVisibilityMutation(
  client: AgentHqApiClient,
  workspaceId: Accessor<string>,
  projectId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    sharingMutationOptions.setProjectVisibility(client, queryClient, workspaceId(), projectId())
  )
}

export function useSetProjectMemberMutation(
  client: AgentHqApiClient,
  workspaceId: Accessor<string>,
  projectId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    sharingMutationOptions.setProjectMember(client, queryClient, workspaceId(), projectId())
  )
}

export function useRemoveProjectMemberMutation(
  client: AgentHqApiClient,
  workspaceId: Accessor<string>,
  projectId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    sharingMutationOptions.removeProjectMember(client, queryClient, workspaceId(), projectId())
  )
}

export function useCreateWorkspaceInvitationMutation(
  client: AgentHqApiClient,
  workspaceId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    sharingMutationOptions.createInvitation(client, queryClient, workspaceId())
  )
}

export function useRevokeWorkspaceInvitationMutation(
  client: AgentHqApiClient,
  workspaceId: Accessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    sharingMutationOptions.revokeInvitation(client, queryClient, workspaceId())
  )
}

export function useAcceptWorkspaceInvitationMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient()
  return useMutation(() => sharingMutationOptions.acceptInvitation(client, queryClient))
}
