import { describe, expect, test } from "bun:test";

import { createAuthAdapter } from "../../src/adapter";
import { createNeonAuthDriver, type NeonSdk } from "../../src/neon-driver";

const providerSession = {
  session: { expiresAt: new Date("2030-01-01T00:00:00.000Z"), id: "session-1" },
  user: { id: "provider-subject", name: "Operator" },
};

describe("Neon SDK driver integration", () => {
  test("bypasses the session cookie cache during refresh", async () => {
    const calls: unknown[] = [];
    const sdk = {
      async getSession(options?: unknown) {
        calls.push(options);
        return { data: providerSession, error: null };
      },
    } as unknown as NeonSdk;

    const adapter = createAuthAdapter(createNeonAuthDriver(sdk));
    expect(await adapter.refreshSession()).not.toBeNull();
    expect(calls).toEqual([{ query: { disableCookieCache: true } }]);
  });

  test("maps an internal session ID to a provider token only inside the driver", async () => {
    let revokedToken: string | undefined;
    const sdk = {
      async listSessions() {
        return { data: [{ id: "session-1", token: "provider-token" }], error: null };
      },
      async revokeSession({ token }: { token: string }) {
        revokedToken = token;
        return { data: true, error: null };
      },
    } as unknown as NeonSdk;

    const adapter = createAuthAdapter(createNeonAuthDriver(sdk));
    await adapter.revokeSession("session-1");
    expect(revokedToken).toBe("provider-token");
    expect(Object.keys(adapter)).not.toContain("token");
  });

  test("fails closed without leaking provider error details", async () => {
    const sdk = {
      async getSession() {
        return {
          data: null,
          error: { message: "raw email operator@example.com and secret token" },
        };
      },
    } as unknown as NeonSdk;

    const driver = createNeonAuthDriver(sdk);
    await expect(driver.getSession()).rejects.toThrow("Authentication provider request failed");
  });
});
