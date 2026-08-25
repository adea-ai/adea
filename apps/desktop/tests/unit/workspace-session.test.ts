import { describe, expect, test } from "bun:test";

import type { ApiWorkspaceBootstrapResponse } from "@agent-hq/api-client";

import { bootstrapDesktopWorkspace } from "../../src/workspace-session";

const workspace = {
  id: "workspace-1",
  name: "My Agent HQ",
  scene: "home" as const,
  updatedAt: "2026-08-25T00:00:00.000Z",
};

function bootstrap(
  temporary: boolean,
  temporaryCredential?: string,
): ApiWorkspaceBootstrapResponse {
  return {
    activeWorkspace: workspace,
    principal: { temporary },
    ...(temporaryCredential ? { temporaryCredential } : {}),
    workspaces: [workspace],
  };
}

describe("desktop workspace session", () => {
  test("creates and saves a guest credential without requiring sign-in", async () => {
    const saved: string[] = [];
    const result = await bootstrapDesktopWorkspace({
      createClient: ({ session, temporaryCredential }) => {
        expect(session).toBeUndefined();
        expect(temporaryCredential).toBeUndefined();
        return {
          bootstrapWorkspace: async () => bootstrap(true, `ahq_tmp_${"a".repeat(43)}`),
          claimTemporaryWorkspace: async () => ({ claimed: true as const }),
        };
      },
      storedTemporaryCredential: null,
      temporaryVault: {
        clear: async () => undefined,
        save: async (credential) => void saved.push(credential),
      },
    });

    expect(result.temporary).toBe(true);
    expect(result.workspace).toEqual(workspace);
    expect(saved).toEqual([`ahq_tmp_${"a".repeat(43)}`]);
  });

  test("reopens an existing guest workspace with its stored credential", async () => {
    const stored = `ahq_tmp_${"b".repeat(43)}`;
    const result = await bootstrapDesktopWorkspace({
      createClient: ({ session, temporaryCredential }) => {
        expect(session).toBeUndefined();
        expect(temporaryCredential).toBe(stored);
        return {
          bootstrapWorkspace: async () => bootstrap(true),
          claimTemporaryWorkspace: async () => ({ claimed: true as const }),
        };
      },
      storedTemporaryCredential: stored,
      temporaryVault: {
        clear: async () => undefined,
        save: async () => undefined,
      },
    });

    expect(result.temporaryCredential).toBe(stored);
    expect(result.workspace.id).toBe("workspace-1");
  });

  test("claims the guest workspace after optional desktop sign-in", async () => {
    const stored = `ahq_tmp_${"c".repeat(43)}`;
    const calls: string[] = [];
    const result = await bootstrapDesktopWorkspace({
      createClient: ({ session, temporaryCredential }) => ({
        bootstrapWorkspace: async () => {
          calls.push(`bootstrap:${session?.sessionId ?? "guest"}:${temporaryCredential ?? "none"}`);
          return bootstrap(false);
        },
        claimTemporaryWorkspace: async (credential) => {
          calls.push(`claim:${session?.sessionId}:${credential}`);
          return { claimed: true as const };
        },
      }),
      session: {
        credential: "desktop-secret",
        expiresAt: "2030-01-01T00:00:00.000Z",
        sessionId: "desktop-session-1",
      },
      storedTemporaryCredential: stored,
      temporaryVault: {
        clear: async () => void calls.push("clear"),
        save: async () => undefined,
      },
    });

    expect(result.temporary).toBe(false);
    expect(result.temporaryCredential).toBeNull();
    expect(calls).toEqual([
      `claim:desktop-session-1:${stored}`,
      "clear",
      "bootstrap:desktop-session-1:none",
    ]);
  });
});
