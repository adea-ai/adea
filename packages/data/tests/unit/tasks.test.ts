import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { taskMutationOptions, taskQueryKeys, taskQueryOptions } from "../../src";

describe("Task query contracts", () => {
  test("keeps list and detail caches workspace scoped", () => {
    const client = {} as never;
    expect(taskQueryOptions.list(client, "workspace-1").queryKey).toEqual(
      taskQueryKeys.list("workspace-1")
    );
    expect(taskQueryOptions.detail(client, "workspace-1", "task-1").queryKey).toEqual(
      taskQueryKeys.detail("workspace-1", "task-1")
    );
  });

  test("invalidates Task caches after lifecycle mutations", async () => {
    const calls: unknown[] = [];
    const client = {
      queueTask: async (...args: unknown[]) => {
        calls.push(args);
        return { task: { id: "task-1", version: 2 } };
      },
    } as never;
    const queryClient = new QueryClient();
    const options = taskMutationOptions.queue(client, queryClient, "workspace-1");
    const result = await options.mutationFn({
      command: { expectedVersion: 1, idempotencyKey: "queue", requestId: "request" },
      taskId: "task-1",
    });
    await options.onSuccess(result);
    expect(calls).toHaveLength(1);
    expect(queryClient.getQueryData(taskQueryKeys.detail("workspace-1", "task-1"))).toEqual(result);
  });
});
