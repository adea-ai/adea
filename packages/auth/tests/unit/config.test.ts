import { describe, expect, test } from "bun:test";

import { readAuthConfig } from "../../src/config";

const validEnvironment = {
  NEON_AUTH_BASE_URL: "https://example.neonauth.us-east-1.aws.neon.tech/neondb/auth",
  NEON_AUTH_COOKIE_SECRET: "a-secure-cookie-secret-that-is-long-enough",
  AUTH_TRUSTED_ORIGINS: "https://agent-hq.example,adea://auth/callback",
};

describe("auth configuration", () => {
  test("requires an HTTPS provider URL and a strong cookie secret", () => {
    expect(() =>
      readAuthConfig({ ...validEnvironment, NEON_AUTH_BASE_URL: "http://remote.test" })
    ).toThrow("HTTPS");
    expect(() =>
      readAuthConfig({ ...validEnvironment, NEON_AUTH_COOKIE_SECRET: "too-short" })
    ).toThrow("32");
  });

  test("requires an exact redirect allowlist without wildcards or credentials", () => {
    expect(() =>
      readAuthConfig({ ...validEnvironment, AUTH_TRUSTED_ORIGINS: "https://*.agent-hq.example" })
    ).toThrow("wildcard");
    expect(() =>
      readAuthConfig({
        ...validEnvironment,
        AUTH_TRUSTED_ORIGINS: "https://user:secret@agent-hq.example",
      })
    ).toThrow("credentials");
  });

  test("accepts local HTTP only for loopback development", () => {
    const config = readAuthConfig({
      ...validEnvironment,
      NEON_AUTH_BASE_URL: "http://127.0.0.1:8787/auth",
      AUTH_TRUSTED_ORIGINS: "http://localhost:3000,adea://auth/callback",
    });

    expect(config.trustedOrigins).toEqual(["http://localhost:3000", "adea://auth/callback"]);
    expect(config.sessionDataTtl).toBe(1);
  });

  test("keeps every exact allowlist entry without adding deployment origins", () => {
    const config = readAuthConfig({
      ...validEnvironment,
      AUTH_TRUSTED_ORIGINS:
        "https://adea.dev,https://adea-web.adea-ai.workers.dev,adea://auth/callback",
    });

    expect(config.trustedOrigins).toEqual([
      "https://adea.dev",
      "https://adea-web.adea-ai.workers.dev",
      "adea://auth/callback",
    ]);
  });
});
