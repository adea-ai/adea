import { describe, expect, test } from "bun:test";
import type { AgentHqApiClient } from "@adea/api-client";
import { QueryClient } from "@tanstack/react-query";

import { workspaceMutationOptions, workspaceQueryKeys, workspaceQueryOptions } from "../../src";

const workspace = {
  id: "workspace-1",
  name: "My Agent HQ",
  scene: "home" as const,
  updatedAt: "2026-08-25T00:00:00.000Z",
};

function client(overrides: Partial<AgentHqApiClient> = {}) {
  return {
    bootstrapWorkspace: async () => ({
      activeWorkspace: workspace,
      principal: { temporary: true },
      workspaces: [workspace],
    }),
    claimTemporaryWorkspace: async () => ({ claimed: true as const }),
    createWorkspace: async () => ({ created: true, workspace }),
    getWorkspace: async () => ({ agents: [], tasks: [], workspace }),
    listWorkspaces: async () => [workspace],
    reopenWorkspace: async () => ({ workspace }),
    ...overrides,
  } as unknown as AgentHqApiClient;
}

describe("workspace query contracts", () => {
  test("uses distinct stable keys for bootstrap, list, and detail queries", async () => {
    const api = client();

    expect(workspaceQueryOptions.bootstrap(api).queryKey).toEqual(["workspaces", "bootstrap"]);
    expect(workspaceQueryOptions.list(api).queryKey).toEqual(["workspaces", "list"]);
    expect(workspaceQueryOptions.detail(api, workspace.id).queryKey).toEqual([
      "workspaces",
      "detail",
      workspace.id,
    ]);
    expect(await workspaceQueryOptions.detail(api, workspace.id).queryFn()).toEqual({
      agents: [],
      tasks: [],
      workspace,
    });
  });

  test("disables detail fetching until a workspace is selected", () => {
    expect(workspaceQueryOptions.detail(client()).enabled).toBe(false);
  });
});

describe("workspace mutation contracts", () => {
  test("creates a workspace and primes its detail cache", async () => {
    const queryClient = new QueryClient();
    const options = workspaceMutationOptions.create(client(), queryClient);
    const result = await options.mutationFn({ idempotencyKey: "create-1", name: workspace.name });
    await options.onSuccess(result);

    expect(queryClient.getQueryData(workspaceQueryKeys.detail(workspace.id))).toEqual({
      agents: [],
      tasks: [],
      workspace,
    });
  });

  test("passes claim and reopen identifiers through their mutations", async () => {
    const calls: string[] = [];
    const api = client({
      claimTemporaryWorkspace: async (credential) => {
        calls.push(`claim:${credential}`);
        return { claimed: true };
      },
      reopenWorkspace: async (workspaceId) => {
        calls.push(`reopen:${workspaceId}`);
        return { workspace };
      },
    });
    const queryClient = new QueryClient();

    const claim = workspaceMutationOptions.claim(api, queryClient);
    await claim.onSuccess(await claim.mutationFn("ahq_tmp_example"));
    const reopen = workspaceMutationOptions.reopen(api, queryClient);
    await reopen.onSuccess(await reopen.mutationFn(workspace.id));

    expect(calls).toEqual(["claim:ahq_tmp_example", `reopen:${workspace.id}`]);
  });
});
