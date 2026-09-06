import { describe, expect, test } from "bun:test";
import type { AgentHqApiClient } from "@adea-ai/api-client";
import { QueryClient } from "@tanstack/react-query";
import { agentMutationOptions, agentQueryKeys, agentQueryOptions } from "../../src";

const agent = {
  createdAt: "now",
  id: "agent-1",
  lifecycleState: "active" as const,
  name: "Ada",
  presentationMetadata: {},
  profile: { id: "engineer", state: "available" as const, version: "1" },
  updatedAt: "now",
  workspaceId: "workspace-1",
};
const client = {
  createAgent: async () => ({ agent }),
  listAgents: async () => [agent],
} as unknown as AgentHqApiClient;

describe("Agent query contracts", () => {
  test("keeps Agent caches workspace scoped and primes identity after creation", async () => {
    expect(agentQueryOptions.list(client, "workspace-1").queryKey).toEqual([
      "workspaces",
      "workspace-1",
      "agents",
      "list",
    ]);
    const queryClient = new QueryClient();
    const mutation = agentMutationOptions.create(client, queryClient, "workspace-1");
    const result = await mutation.mutationFn({
      name: "Ada",
      profileId: "engineer",
      profileVersion: "1",
    });
    await mutation.onSuccess(result);
    expect(queryClient.getQueryData(agentQueryKeys.detail("workspace-1", agent.id))).toEqual({
      agent,
    });
  });
});
