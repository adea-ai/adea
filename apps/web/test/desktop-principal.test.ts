import { describe, expect, test } from "bun:test";

import type { AuthResult } from "@adea/auth";

import { resolveOrProvisionDesktopPrincipal } from "../src/server/desktop-principal";

const authentication: AuthResult = {
  identity: { provider: "neon", subject: "provider-subject" },
  profile: { displayName: "Operator", email: "operator@example.com" },
  session: { expiresAt: "2030-01-01T00:00:00.000Z", id: "provider-session" },
};

describe("desktop stable identity provisioning", () => {
  test("creates the first stable user mapping and then resolves it", async () => {
    const principals: Array<{ kind: "user"; userId: string }> = [];
    const principal = await resolveOrProvisionDesktopPrincipal(authentication, {
      async findUserPrincipals() {
        return principals;
      },
      async provision(input) {
        expect(input).toEqual({
          identity: authentication.identity,
          profile: { displayName: "Operator" },
        });
        principals.push({ kind: "user", userId: "user-1" });
      },
      async setDisplayNameIfMissing() {},
    });

    expect(principal).toEqual({ kind: "user", userId: "user-1" });
  });

  test("does not provision an identity that already resolves", async () => {
    let provisioned = false;
    let profileUpdate: unknown;
    const principal = await resolveOrProvisionDesktopPrincipal(authentication, {
      async findUserPrincipals() {
        return [{ kind: "user", userId: "user-1" }];
      },
      async provision() {
        provisioned = true;
      },
      async setDisplayNameIfMissing(input) {
        profileUpdate = input;
      },
    });

    expect(principal).toEqual({ kind: "user", userId: "user-1" });
    expect(provisioned).toBeFalse();
    expect(profileUpdate).toEqual({ displayName: "Operator", userId: "user-1" });
  });

  test("uses the account email when an existing identity has no username", async () => {
    let profileUpdate: unknown;
    const principal = await resolveOrProvisionDesktopPrincipal(
      { ...authentication, profile: { email: "operator@example.com" } },
      {
        async findUserPrincipals() {
          return [{ kind: "user", userId: "user-1" }];
        },
        async provision() {},
        async setDisplayNameIfMissing(input) {
          profileUpdate = input;
        },
      }
    );

    expect(principal).toEqual({ kind: "user", userId: "user-1" });
    expect(profileUpdate).toEqual({ displayName: "operator@example.com", userId: "user-1" });
  });

  test("does not reject an existing identity when optional profile enrichment fails", async () => {
    await expect(
      resolveOrProvisionDesktopPrincipal(authentication, {
        async findUserPrincipals() {
          return [{ kind: "user", userId: "user-1" }];
        },
        async provision() {},
        async setDisplayNameIfMissing() {
          throw new Error("profile update unavailable");
        },
      })
    ).resolves.toEqual({ kind: "user", userId: "user-1" });
  });

  test("resolves the winning stable user when concurrent provisioning loses the insert race", async () => {
    const principals: Array<{ kind: "user"; userId: string }> = [];
    const principal = await resolveOrProvisionDesktopPrincipal(authentication, {
      async findUserPrincipals() {
        return principals;
      },
      async provision() {
        principals.push({ kind: "user", userId: "winner" });
        throw new Error("duplicate identity");
      },
      async setDisplayNameIfMissing() {},
    });

    expect(principal).toEqual({ kind: "user", userId: "winner" });
  });
});
