import { describe, expect, test } from "bun:test";

import { AgentHqApiClient } from "../../src";

describe("Marketplace API client", () => {
  test("uses same-origin marketplace routes and sends exact install pins", async () => {
    const requests: Request[] = [];
    const client = new AgentHqApiClient({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        const request = new Request(`https://agent-hq.example${input}`, init);
        requests.push(request);
        return Response.json(
          request.url.endsWith("/catalog")
            ? {
                artifacts: {},
                catalogId: "catalog:test",
                installations: [],
                releaseId: "catalog:test",
              }
            : {
                canonicalContentDigest: "sha256:test",
                installationId: "ins_test",
                releaseId: "release:test",
                state: "pending-authorization",
              }
        );
      },
    });
    await client.getMarketplaceCatalog("workspace-1");
    await client.requestMarketplaceInstall("workspace-1", {
      canonicalContentDigest: `sha256:${"a".repeat(64)}`,
      idempotencyKey: "marketplace-install-1",
      pluginId: "plugin:openai-official:gmail",
      releaseId: `release:${"b".repeat(64)}`,
      requestedHarness: "codex",
      workspaceIdentity: { userId: "user-1", workspaceId: "workspace-1" },
    });

    expect(requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ["POST", "/api/marketplace/catalog"],
      ["POST", "/api/marketplace/install"],
    ]);
    expect(await requests[1]!.json()).toMatchObject({
      canonicalContentDigest: `sha256:${"a".repeat(64)}`,
      pluginId: "plugin:openai-official:gmail",
      releaseId: `release:${"b".repeat(64)}`,
      requestedHarness: "codex",
    });
    expect(requests[1]?.url).not.toContain("github.com");
  });
});
