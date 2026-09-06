import { describe, expect, test } from "bun:test";

import {
  assertTrustedOrigin,
  createAuthorizationState,
  verifyAuthorizationState,
} from "../../src/security";

describe("auth request security", () => {
  test("fails closed for missing and wrong origins", () => {
    const trusted = ["https://agent-hq.example", "adea://auth/callback"];
    expect(() => assertTrustedOrigin(undefined, trusted)).toThrow("origin");
    expect(() => assertTrustedOrigin("https://attacker.example", trusted)).toThrow("origin");
    expect(assertTrustedOrigin("https://agent-hq.example/path", trusted)).toBe(
      "https://agent-hq.example"
    );
  });

  test("binds redirect, state, nonce, and verifier to a single callback", async () => {
    const transaction = await createAuthorizationState({
      redirectUri: "adea://auth/callback",
      trustedOrigins: ["adea://auth/callback"],
    });

    expect(transaction.state).not.toBe(transaction.nonce);
    expect(transaction.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(
      await verifyAuthorizationState(transaction, {
        state: transaction.state,
        nonce: transaction.nonce,
        redirectUri: "adea://auth/callback",
      })
    ).toBe(true);
    await expect(
      verifyAuthorizationState(transaction, {
        state: "wrong",
        nonce: transaction.nonce,
        redirectUri: "adea://auth/callback",
      })
    ).rejects.toThrow("state");
  });
});
