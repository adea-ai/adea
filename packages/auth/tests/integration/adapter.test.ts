import { describe, expect, test } from "bun:test";

import { createAuthAdapter, type AuthDriver } from "../../src/adapter";

function createDriver(): AuthDriver & { revoked: Set<string> } {
  let activeSession = {
    session: { expiresAt: new Date("2030-01-01T00:00:00.000Z"), id: "session-before-refresh" },
    user: { id: "provider-subject", name: "Operator" },
  };
  const revoked = new Set<string>();

  return {
    revoked,
    async getSession() {
      return revoked.has(activeSession.session.id) ? null : activeSession;
    },
    async refreshSession() {
      activeSession = {
        ...activeSession,
        session: { ...activeSession.session, id: "session-after-refresh" },
      };
      return activeSession;
    },
    async signIn() {
      return activeSession;
    },
    async signUp() {
      return activeSession;
    },
    async signOut() {
      revoked.add(activeSession.session.id);
    },
    async revokeSession(sessionId) {
      revoked.add(sessionId);
    },
  };
}

describe("provider adapter integration", () => {
  test("refreshes a session without changing the provider identity", async () => {
    const adapter = createAuthAdapter(createDriver());
    const before = await adapter.getSession();
    const after = await adapter.refreshSession();

    expect(before?.identity).toEqual(after?.identity);
    expect(after?.session.id).toBe("session-after-refresh");
    expect(adapter).not.toHaveProperty("authorizeWorkspace");
  });

  test("logout and explicit revocation fail closed on later lookup", async () => {
    const driver = createDriver();
    const adapter = createAuthAdapter(driver);

    await adapter.signOut();
    expect(await adapter.getSession()).toBeNull();

    const secondDriver = createDriver();
    const secondAdapter = createAuthAdapter(secondDriver);
    await secondAdapter.revokeSession("session-before-refresh");
    expect(await secondAdapter.getSession()).toBeNull();
  });
});
