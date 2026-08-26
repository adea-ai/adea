import { describe, expect, test } from "bun:test";

import {
  applyDesktopWorkspaceCors,
  desktopTrustedOrigins,
  desktopWorkspacePreflight,
  rejectUntrustedDesktopWorkspaceRequest,
  trustedDesktopWorkspaceRequest,
} from "../src/server/desktop-workspace";

const trustedOrigins = ["tauri://localhost", "http://127.0.0.1:1420"];

function request(origin: string, client = "desktop") {
  return new Request("https://hq.example/api/workspaces/bootstrap", {
    headers: { origin, "x-agent-hq-client": client },
    method: "POST",
  });
}

describe("desktop workspace HTTP boundary", () => {
  test("allows the fixed local Tauri development origin against the production cloud", () => {
    expect(desktopTrustedOrigins({ NODE_ENV: "production" })).toContain("http://127.0.0.1:1420");
    expect(
      desktopTrustedOrigins({
        DESKTOP_AUTH_TRUSTED_ORIGINS: "tauri://localhost",
        NODE_ENV: "production",
      }),
    ).toContain("http://127.0.0.1:1420");
  });

  test("recognizes only an explicitly marked request from a trusted packaged origin", () => {
    expect(trustedDesktopWorkspaceRequest(request("tauri://localhost"), trustedOrigins)).toBe(true);
    expect(
      trustedDesktopWorkspaceRequest(request("https://hq.example", "browser"), trustedOrigins),
    ).toBe(false);
    expect(trustedDesktopWorkspaceRequest(request("https://evil.example"), trustedOrigins)).toBe(
      false,
    );
  });

  test("rejects untrusted desktop markers before workspace provisioning", async () => {
    expect(
      rejectUntrustedDesktopWorkspaceRequest(request("tauri://localhost"), trustedOrigins),
    ).toBeNull();
    const rejected = rejectUntrustedDesktopWorkspaceRequest(
      request("https://evil.example"),
      trustedOrigins,
    );
    expect(rejected?.status).toBe(403);
    expect(rejected?.headers.get("access-control-allow-origin")).toBeNull();
    expect(await rejected?.json()).toEqual({
      code: "workspace_unavailable",
      message: "Workspace unavailable",
    });
  });

  test("limits preflight and response CORS to trusted desktop origins", () => {
    const preflight = desktopWorkspacePreflight(request("tauri://localhost"), trustedOrigins);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "X-Agent-HQ-Temporary-Session",
    );

    const response = applyDesktopWorkspaceCors(
      Response.json({ ok: true }),
      request("tauri://localhost"),
      trustedOrigins,
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(response.headers.get("vary")).toContain("Origin");

    const untrustedPreflight = desktopWorkspacePreflight(
      request("https://evil.example"),
      trustedOrigins,
    );
    expect(untrustedPreflight.status).toBe(403);
    expect(untrustedPreflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});
