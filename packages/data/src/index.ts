import { useQuery } from "@tanstack/react-query";
import type { AgentHqApiClient } from "@agent-hq/api-client";

export { AgentHqQueryProvider } from "./provider";

export const workspaceQueryKeys = {
  all: ["workspaces"] as const,
  detail: (workspaceId: string) => ["workspaces", workspaceId] as const,
};

export function useWorkspaceQuery(client: AgentHqApiClient, workspaceId?: string) {
  return useQuery({
    queryKey: workspaceQueryKeys.detail(workspaceId ?? ""),
    queryFn: () => client.getWorkspace(workspaceId!),
    enabled: Boolean(workspaceId),
  });
}
