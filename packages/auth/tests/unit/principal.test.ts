import { describe, expect, test } from "bun:test";

import type { PrincipalRef } from "@agent-hq/types";

import { resolveAuthenticatedPrincipal } from "../../src/principal";
import type { AuthResult } from "../../src/session";

const authenticated: AuthResult = {
  identity: { provider: "neon", subject: "provider-subject" },
  profile: {},
  session: { expiresAt: "2030-01-01T00:00:00.000Z", id: "session-1" },
};

function mapping(principals: readonly PrincipalRef[]) {
  return {
    async findUserPrincipals() {
      return principals;
    },
  };
}

describe("authenticated principal resolution", () => {
  test("maps a provider session to one stable domain user principal", async () => {
    const principal = { kind: "user", userId: "stable-user-id" } as const;

    expect(await resolveAuthenticatedPrincipal(authenticated, mapping([principal]))).toEqual(
      principal
    );
  });

  test("fails closed for unknown, revoked, ambiguous, or non-user mappings", async () => {
    const user = { kind: "user", userId: "stable-user-id" } as const;
    const otherUser = { kind: "user", userId: "other-user-id" } as const;
    const service = { kind: "service", serviceId: "service-id" } as const;

    expect(await resolveAuthenticatedPrincipal(authenticated, mapping([]))).toBeNull();
    expect(
      await resolveAuthenticatedPrincipal(authenticated, mapping([user, otherUser]))
    ).toBeNull();
    expect(await resolveAuthenticatedPrincipal(authenticated, mapping([service]))).toBeNull();
    expect(
      await resolveAuthenticatedPrincipal(authenticated, {
        async findUserPrincipals() {
          throw new Error("provider details must not escape");
        },
      })
    ).toBeNull();
  });
});
