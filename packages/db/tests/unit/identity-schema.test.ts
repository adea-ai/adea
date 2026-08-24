import { describe, expect, test } from "bun:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import {
  authIdentities,
  desktopAuthorizationCodes,
  desktopSessions,
  users,
} from "../../src/schema";

describe("identity schema", () => {
  test("keeps stable users separate from provider identities", () => {
    const userConfig = getTableConfig(users);
    const identityConfig = getTableConfig(authIdentities);

    expect(userConfig.schema).toBe("app");
    expect(identityConfig.schema).toBe("app");
    expect(identityConfig.foreignKeys).toHaveLength(1);
    expect(identityConfig.uniqueConstraints).toHaveLength(1);
    expect(identityConfig.indexes.length).toBeGreaterThan(0);
    expect(Object.keys(users)).not.toContain("subject");
    expect(Object.keys(users)).not.toContain("provider");
  });

  test("stores only digests for short-lived desktop credentials", () => {
    const codeConfig = getTableConfig(desktopAuthorizationCodes);
    const sessionConfig = getTableConfig(desktopSessions);

    expect(codeConfig.schema).toBe("app");
    expect(sessionConfig.schema).toBe("app");
    expect(codeConfig.foreignKeys).toHaveLength(1);
    expect(sessionConfig.foreignKeys).toHaveLength(1);
    expect(codeConfig.columns.map(({ name }) => name)).not.toContain("code");
    expect(sessionConfig.columns.map(({ name }) => name)).not.toContain("credential");
    expect(sessionConfig.uniqueConstraints).toHaveLength(1);
  });
});
