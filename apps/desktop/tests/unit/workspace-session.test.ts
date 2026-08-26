import { describe, expect, test } from "bun:test";

import type { ApiWorkspaceBootstrapResponse } from "@agent-hq/api-client";

import {
  bootstrapDesktopWorkspace,
  createWorkspaceRequestGuard,
  loadTemporaryWorkspaceCredential,
} from "../../src/workspace-session";

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
  test("prevents an older workspace request from overwriting a newer callback request", () => {
    const guard = createWorkspaceRequestGuard();
    const guestRequestIsCurrent = guard.begin();
    const callbackRequestIsCurrent = guard.begin();

    expect(guestRequestIsCurrent()).toBeFalse();
    expect(callbackRequestIsCurrent()).toBeTrue();
  });

  test("does not block guest startup when the temporary credential vault does not answer", async () => {
    await expect(
      loadTemporaryWorkspaceCredential(() => new Promise<string | null>(() => undefined), 5),
    ).resolves.toBeNull();
  });

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

  test("keeps the guest workspace usable when device credential persistence is unavailable", async () => {
    const credential = `ahq_tmp_${"d".repeat(43)}`;
    const result = await bootstrapDesktopWorkspace({
      createClient: ({ session, temporaryCredential }) => {
        expect(session).toBeUndefined();
        expect(temporaryCredential).toBeUndefined();
        return {
          bootstrapWorkspace: async () => bootstrap(true, credential),
          claimTemporaryWorkspace: async () => ({ claimed: true as const }),
        };
      },
      storedTemporaryCredential: null,
      temporaryVault: {
        clear: async () => undefined,
        save: async () => {
          throw new Error("device credential vault unavailable");
        },
      },
    });

    expect(result.temporary).toBe(true);
    expect(result.temporaryCredential).toBe(credential);
    expect(result.temporaryCredentialPersisted).toBe(false);
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
      onTemporaryCredentialClaimed: () => void calls.push("claimed"),
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
      "claimed",
      "bootstrap:desktop-session-1:none",
    ]);
  });

  test("reports a successful claim before a later account bootstrap failure", async () => {
    const stored = `ahq_tmp_${"e".repeat(43)}`;
    let claimed = false;

    await expect(
      bootstrapDesktopWorkspace({
        createClient: () => ({
          bootstrapWorkspace: async () => {
            throw new Error("workspace service unavailable");
          },
          claimTemporaryWorkspace: async () => ({ claimed: true as const }),
        }),
        session: {
          credential: "desktop-secret",
          expiresAt: "2030-01-01T00:00:00.000Z",
          sessionId: "desktop-session-1",
        },
        storedTemporaryCredential: stored,
        onTemporaryCredentialClaimed: () => {
          claimed = true;
        },
        temporaryVault: {
          clear: async () => undefined,
          save: async () => undefined,
        },
      }),
    ).rejects.toThrow("workspace service unavailable");

    expect(claimed).toBeTrue();
  });
});
