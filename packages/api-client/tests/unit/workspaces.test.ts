import { describe, expect, test } from "bun:test";

import { ApiClientError, createApiClient } from "../../src";

const workspace = {
  id: "workspace-1",
  name: "My Agent HQ",
  scene: "home" as const,
  updatedAt: "2026-08-25T00:00:00.000Z",
};

describe("workspace API client", () => {
  test("bootstraps an anonymous workspace with browser credentials", async () => {
    let request: Request | undefined;
    const client = createApiClient({
      baseUrl: "https://hq.example/api",
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          activeWorkspace: workspace,
          principal: { temporary: true },
          workspaces: [workspace],
        });
      },
    });

    expect((await client.bootstrapWorkspace()).activeWorkspace).toEqual(workspace);
    expect(request?.method).toBe("POST");
    expect(request?.credentials).toBe("include");
  });

  test("bootstraps a desktop guest and requests its keychain credential", async () => {
    let request: Request | undefined;
    let credentials: RequestCredentials | undefined;
    const client = createApiClient({
      baseUrl: "https://hq.example/api",
      client: "desktop",
      fetchImpl: async (input, init) => {
        credentials = init?.credentials;
        request = new Request(input, init);
        return Response.json({
          activeWorkspace: workspace,
          principal: { temporary: true },
          temporaryCredential: "ahq_tmp_secret",
          workspaces: [workspace],
        });
      },
    });

    expect((await client.bootstrapWorkspace()).temporaryCredential).toBe("ahq_tmp_secret");
    expect(credentials).toBe("omit");
    expect(request?.headers.get("x-agent-hq-client")).toBe("desktop");
  });

  test("sends a temporary desktop credential and idempotency key on creation", async () => {
    let request: Request | undefined;
    const client = createApiClient({
      baseUrl: "https://hq.example/api",
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ created: true, workspace });
      },
      getTemporaryCredential: () => "temporary-secret",
    });

    await client.createWorkspace({ idempotencyKey: "retry-1", name: "My Agent HQ", scene: "home" });
    expect(request?.headers.get("authorization")).toBe("Temporary temporary-secret");
    expect(request?.headers.get("idempotency-key")).toBe("retry-1");
    expect(await request?.json()).toEqual({ name: "My Agent HQ", scene: "home" });
  });

  test("normalizes opaque API failures", async () => {
    const client = createApiClient({
      fetchImpl: async () =>
        Response.json(
          { code: "workspace_unavailable", message: "Workspace unavailable" },
          { status: 404 }
        ),
    });

    await expect(client.getWorkspace("private")).rejects.toEqual(
      new ApiClientError("Workspace unavailable", 404, "workspace_unavailable")
    );
  });

  test("preserves normalized 401, 403, 404, validation, and conflict status contracts", async () => {
    for (const [status, code, message] of [
      [401, "workspace_unavailable", "Workspace unavailable"],
      [403, "workspace_unavailable", "Workspace unavailable"],
      [404, "workspace_unavailable", "Workspace unavailable"],
      [400, "invalid_request", "Invalid request"],
      [409, "conflict", "Request conflict"],
    ] as const) {
      const client = createApiClient({
        fetchImpl: async () => Response.json({ code, message }, { status }),
      });

      await expect(client.listWorkspaces()).rejects.toEqual(
        new ApiClientError(message, status, code)
      );
    }
  });

  test("claims a guest credential with the authenticated desktop session", async () => {
    let request: Request | undefined;
    const client = createApiClient({
      baseUrl: "https://hq.example/api",
      client: "desktop",
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ claimed: true });
      },
      getDesktopSession: () => ({
        credential: "desktop-secret",
        sessionId: "018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1",
      }),
    });

    await expect(client.claimTemporaryWorkspace("ahq_tmp_guest-secret")).resolves.toEqual({
      claimed: true,
    });
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Desktop desktop-secret");
    expect(request?.headers.get("x-agent-hq-desktop-session")).toBe(
      "018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1"
    );
    expect(request?.headers.get("x-agent-hq-temporary-session")).toBe("ahq_tmp_guest-secret");
  });

  test("reopens a workspace through the typed contract", async () => {
    let request: Request | undefined;
    const client = createApiClient({
      baseUrl: "https://hq.example/api",
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ workspace });
      },
    });

    await expect(client.reopenWorkspace("workspace/one")).resolves.toEqual({ workspace });
    expect(new URL(request!.url).pathname).toBe("/api/workspaces/workspace%2Fone/reopen");
    expect(request?.method).toBe("POST");
  });
});
