import { describe, expect, test } from "bun:test";

import { AgentHqApiClient } from "../../src";

describe("ContentRef API client", () => {
  test("sends only cloud-safe metadata through the opaque ContentRef routes", async () => {
    const requests: Request[] = [];
    const client = new AgentHqApiClient({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        requests.push(new Request(`https://test${input}`, init));
        return Response.json({ contentRef: { id: "content-1" } });
      },
    });
    await client.createContentRef("workspace/1", {
      availability: "missing",
      contentType: "task_input",
      digestSha256: "a".repeat(64),
      id: "content-1",
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: "restricted",
      storagePolicy: "local_authority",
      synchronizationPolicy: "local_only",
    });
    await client.getContentRef("workspace/1", "content/1");
    await client.updateContentRef("workspace/1", "content/1", {
      availability: "available",
      digestSha256: "a".repeat(64),
      expectedRevision: 1,
      keyVersion: 1,
      revision: 1,
    });

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v1/workspaces/workspace%2F1/content-refs",
      "/api/v1/workspaces/workspace%2F1/content-refs/content%2F1",
      "/api/v1/workspaces/workspace%2F1/content-refs/content%2F1",
    ]);
    expect(await requests[0]!.text()).not.toMatch(/plaintext|ciphertext|nonce|masterKey/i);
    expect(requests[2]?.method).toBe("PATCH");
  });
});
