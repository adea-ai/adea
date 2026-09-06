import { describe, expect, test } from "bun:test";
import type { AgentHqApiClient } from "@adea/api-client";
import { QueryClient } from "@tanstack/react-query";

import { roomMutationOptions, roomQueryKeys, roomQueryOptions } from "../../src";

const room = {
  createdAt: "2026-08-30T00:00:00.000Z",
  functionKey: "engineering",
  id: "room-1",
  lifecycleState: "active" as const,
  name: "Engineering",
  sortOrder: 0,
  updatedAt: "2026-08-30T00:00:00.000Z",
  workspaceId: "workspace-1",
};

function client(overrides: Partial<AgentHqApiClient> = {}) {
  return {
    archiveRoom: async () => ({ archived: true as const }),
    createRoom: async () => ({ room }),
    getRoom: async () => ({ room }),
    listRooms: async () => [room],
    reorderRooms: async () => [room],
    updateRoom: async () => ({ room }),
    ...overrides,
  } as unknown as AgentHqApiClient;
}

describe("room query contracts", () => {
  test("uses stable workspace-scoped list and detail keys", async () => {
    const api = client();
    expect(roomQueryOptions.list(api, "workspace-1").queryKey).toEqual([
      "workspaces",
      "workspace-1",
      "rooms",
      "list",
    ]);
    expect(roomQueryOptions.detail(api, "workspace-1", "room-1").queryKey).toEqual([
      "workspaces",
      "workspace-1",
      "rooms",
      "detail",
      "room-1",
    ]);
    expect(await roomQueryOptions.detail(api, "workspace-1", "room-1").queryFn()).toEqual({ room });
  });
});

describe("room mutation contracts", () => {
  test("invalidates the workspace room collection after creation", async () => {
    const queryClient = new QueryClient();
    await queryClient.setQueryData(roomQueryKeys.list("workspace-1"), [room]);
    const options = roomMutationOptions.create(client(), queryClient, "workspace-1");
    const result = await options.mutationFn({ functionKey: "engineering", name: "Engineering" });
    await options.onSuccess(result);
    expect(queryClient.getQueryState(roomQueryKeys.list("workspace-1"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(roomQueryKeys.detail("workspace-1", room.id))).toEqual({
      room,
    });
  });
});
