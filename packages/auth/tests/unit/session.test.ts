import { describe, expect, test } from "bun:test";

import { normalizeNeonSession } from "../../src/session";

describe("session normalization", () => {
  test("keeps provider identity distinct from a domain user ID", () => {
    const result = normalizeNeonSession(
      {
        session: { expiresAt: new Date("2030-01-01T00:00:00.000Z"), id: "session-1" },
        user: { id: "provider-subject", email: "operator@example.com", name: "Operator" },
      },
      new Date("2029-01-01T00:00:00.000Z")
    );

    expect(result).toEqual({
      identity: { provider: "neon", subject: "provider-subject" },
      session: { expiresAt: "2030-01-01T00:00:00.000Z", id: "session-1" },
      profile: { displayName: "Operator", email: "operator@example.com" },
    });
    expect(result).not.toHaveProperty("userId");
  });

  test("fails closed for missing, expired, or malformed sessions", () => {
    expect(normalizeNeonSession(null)).toBeNull();
    expect(() =>
      normalizeNeonSession({
        session: { expiresAt: new Date("2020-01-01T00:00:00.000Z"), id: "expired" },
        user: { id: "provider-subject" },
      })
    ).toThrow("expired");
    expect(() => normalizeNeonSession({ session: {}, user: {} })).toThrow("malformed");
  });
});
