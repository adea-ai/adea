import { describe, expect, test } from "bun:test";

import { workspaceJsonResponse } from "../src/server/workspace-response";

const resolution = {
  clearTemporaryCredential: false,
  createdCredential: `adea_tmp_${"a".repeat(43)}`,
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  principal: { kind: "user" as const, userId: "temporary-user" },
  sessionRotated: false,
  temporary: true,
};

describe("workspace response credentials", () => {
  test("sets an HttpOnly browser cookie but returns no desktop cookie", () => {
    const browser = workspaceJsonResponse(
      { ok: true },
      resolution,
      new Request("http://localhost/api/workspaces/bootstrap", { method: "POST" })
    );
    expect(browser.headers.get("set-cookie")).toContain("agent_hq_temporary_session=adea_tmp_");
    expect(browser.headers.get("set-cookie")).toContain("HttpOnly");

    const desktop = workspaceJsonResponse(
      { ok: true },
      resolution,
      new Request("http://localhost/api/workspaces/bootstrap", {
        headers: {
          origin: "http://127.0.0.1:1420",
          "x-adea-client": "desktop",
        },
        method: "POST",
      })
    );
    expect(desktop.headers.get("set-cookie")).toBeNull();
    expect(desktop.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:1420");
  });
});
