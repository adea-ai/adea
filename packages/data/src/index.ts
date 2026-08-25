import type { AgentHqApiClient } from "@agent-hq/api-client";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export { AgentHqQueryProvider } from "./provider";

export const workspaceQueryKeys = {
  all: ["workspaces"] as const,
  bootstrap: ["workspaces", "bootstrap"] as const,
  detail: (workspaceId: string) => ["workspaces", "detail", workspaceId] as const,
  list: ["workspaces", "list"] as const,
};

export const workspaceQueryOptions = {
  bootstrap: (client: AgentHqApiClient) => ({
    queryKey: workspaceQueryKeys.bootstrap,
    queryFn: () => client.bootstrapWorkspace(),
    staleTime: 30_000,
  }),
  detail: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: workspaceQueryKeys.detail(workspaceId ?? ""),
    queryFn: () => client.getWorkspace(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
  list: (client: AgentHqApiClient) => ({
    queryKey: workspaceQueryKeys.list,
    queryFn: () => client.listWorkspaces(),
  }),
};

export const workspaceMutationOptions = {
  claim: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (temporaryCredential: string) =>
      client.claimTemporaryWorkspace(temporaryCredential),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
    },
  }),
  create: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (input: Parameters<AgentHqApiClient["createWorkspace"]>[0]) =>
      client.createWorkspace(input),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient["createWorkspace"]>>) => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
      queryClient.setQueryData(workspaceQueryKeys.detail(result.workspace.id), {
        workspace: result.workspace,
        agents: [],
        tasks: [],
      });
    },
  }),
  reopen: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (workspaceId: string) => client.reopenWorkspace(workspaceId),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient["reopenWorkspace"]>>) => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.detail(result.workspace.id),
      });
    },
  }),
};

export function useWorkspaceBootstrapQuery(client: AgentHqApiClient) {
  return useQuery(workspaceQueryOptions.bootstrap(client));
}

export function useWorkspaceListQuery(client: AgentHqApiClient) {
  return useQuery(workspaceQueryOptions.list(client));
}

export function useWorkspaceQuery(client: AgentHqApiClient, workspaceId?: string) {
  return useQuery(workspaceQueryOptions.detail(client, workspaceId));
}

export function useCreateWorkspaceMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient();
  return useMutation(workspaceMutationOptions.create(client, queryClient));
}

export function useReopenWorkspaceMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient();
  return useMutation(workspaceMutationOptions.reopen(client, queryClient));
}

export function useClaimTemporaryWorkspaceMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient();
  return useMutation(workspaceMutationOptions.claim(client, queryClient));
}
